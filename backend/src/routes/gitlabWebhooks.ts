import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { advanceTaskFromRunTerminal } from "../modules/workflow/taskProgress.js";
import { triggerPmAutoAdvance } from "../modules/pm/pmAutoAdvance.js";
import { triggerTaskAutoAdvance } from "../modules/workflow/taskAutoAdvance.js";
import { buildRunScmStateUpdate } from "../modules/scm/runScmState.js";

function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const key = name.toLowerCase();
  const v = (headers as any)[key] as unknown;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeGitLabLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (!label || typeof label !== "object") return null;
      const title = (label as any).title ?? (label as any).name;
      return typeof title === "string" ? title.trim() : null;
    })
    .filter((x): x is string => Boolean(x));
}

export function makeGitLabWebhookRoutes(deps: {
  prisma: PrismaDeps;
  webhookSecret?: string;
  onIssueUpserted?: (issueId: string, reason: string) => void;
  broadcastToClients?: (payload: unknown) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const webhookSecret =
      typeof deps.webhookSecret === "string" && deps.webhookSecret.trim() ? deps.webhookSecret.trim() : null;

    server.post("/gitlab", async (request) => {
      const event = getHeader(request.headers as any, "x-gitlab-event") ?? "";

      const issueSchema = z.object({
        object_kind: z.literal("issue"),
        event_type: z.string().optional(),
        project: z
          .object({
            id: z.number().int().positive().optional(),
            web_url: z.string().min(1).optional(),
          })
          .optional(),
        object_attributes: z.object({
          id: z.union([z.number().int().positive(), z.string().min(1)]),
          iid: z.number().int().positive(),
          title: z.string().min(1),
          description: z.string().nullable().optional(),
          state: z.string().optional(),
          action: z.string().optional(),
          url: z.string().min(1).optional(),
        }),
        labels: z.array(z.any()).optional(),
      });

      const pipelineSchema = z.object({
        object_kind: z.literal("pipeline"),
        project: z
          .object({
            id: z.number().int().positive().optional(),
            web_url: z.string().min(1).optional(),
          })
          .optional(),
        object_attributes: z.object({
          id: z.union([z.number().int().positive(), z.string().min(1)]),
          ref: z.string().nullable().optional(),
          sha: z.string().nullable().optional(),
          status: z.string().nullable().optional(),
          detailed_status: z.string().nullable().optional(),
          finished_at: z.string().nullable().optional(),
        }),
        merge_request: z.any().optional(),
        merge_requests: z.array(z.any()).optional(),
      });

      const bodySchema = z.discriminatedUnion("object_kind", [issueSchema, pipelineSchema]);

      let payload: z.infer<typeof bodySchema>;
      try {
        payload = bodySchema.parse(request.body ?? {});
      } catch (err) {
        return {
          success: false,
          error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) },
        };
      }

      const projectId = payload.project?.id;
      if (!projectId) {
        return { success: false, error: { code: "NO_PROJECT_ID", message: "Webhook payload 缺少 project.id" } };
      }

      const project = await deps.prisma.project.findFirst({
        where: { gitlabProjectId: projectId },
      });
      if (!project) {
        return { success: false, error: { code: "NO_PROJECT", message: "未找到与该 GitLab projectId 匹配的 Project" } };
      }

      const token = getHeader(request.headers as any, "x-gitlab-token") ?? "";
      const effectiveSecret = String((project as any).gitlabWebhookSecret ?? webhookSecret ?? "").trim();
      if (effectiveSecret) {
        if (!token || !safeTimingEqual(token, effectiveSecret)) {
          return { success: false, error: { code: "BAD_TOKEN", message: "GitLab webhook token 校验失败" } };
        }
      }

      if (payload.object_kind === "pipeline") {
        const status = String(payload.object_attributes.status ?? payload.object_attributes.detailed_status ?? "")
          .trim()
          .toLowerCase();
        const branch = String(payload.object_attributes.ref ?? "").trim();
        const sha = String(payload.object_attributes.sha ?? "").trim();
        const terminalStatuses = new Set(["success", "failed", "canceled", "cancelled", "skipped"]);
        if (!branch || !terminalStatuses.has(status)) {
          return { success: true, data: { ok: true, ignored: true, reason: "NOT_COMPLETED", event, status, branch } };
        }

        let run = await deps.prisma.run
          .findFirst({
            where: { status: "waiting_ci", branchName: branch, issue: { projectId: (project as any).id } } as any,
            orderBy: { startedAt: "desc" },
            select: { id: true, issueId: true, taskId: true, stepId: true },
          })
          .catch(() => null);

        if (!run) {
          run = await deps.prisma.run
            .findFirst({
              where: { branchName: branch, issue: { projectId: (project as any).id } } as any,
              orderBy: { startedAt: "desc" },
              select: { id: true, issueId: true, taskId: true, stepId: true },
            })
            .catch(() => null);
        }

        if (!run) {
          return { success: true, data: { ok: true, ignored: true, reason: "NO_RUN", branch } };
        }

        const passed = status === "success";
        const now = new Date();

        await deps.prisma.run
          .update({
            where: { id: (run as any).id },
            data: buildRunScmStateUpdate(
              { scmProvider: "gitlab", scmHeadSha: sha || null, scmCiStatus: passed ? "passed" : "failed" },
              { now },
            ) as any,
          })
          .catch(() => {});

        await deps.prisma.run
          .update({
            where: { id: (run as any).id },
            data: {
              status: passed ? "completed" : "failed",
              completedAt: now,
              ...(passed ? null : { failureReason: "ci_failed", errorMessage: `ci_failed: ${status || "unknown"}` }),
            } as any,
          })
          .catch(() => {});

        await advanceTaskFromRunTerminal(
          { prisma: deps.prisma },
          (run as any).id,
          passed ? "completed" : "failed",
          passed ? undefined : { errorMessage: `ci_failed: ${status || "unknown"}` },
        ).catch(() => {});

        if ((run as any).taskId) {
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: (run as any).id,
          });
        }

        triggerPmAutoAdvance(
          { prisma: deps.prisma },
          { runId: (run as any).id, issueId: (run as any).issueId, trigger: "ci_completed" },
        );

        if ((run as any).taskId) {
          triggerTaskAutoAdvance(
            { prisma: deps.prisma, broadcastToClients: deps.broadcastToClients },
            { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "ci_completed" },
          );
        }

        return { success: true, data: { ok: true, handled: true, runId: (run as any).id, passed } };
      }

      const action = String(payload.object_attributes.action ?? "").trim().toLowerCase();
      const shouldCreate = action === "open" || action === "reopen";

      const externalId = String(payload.object_attributes.id);
      const existing = await deps.prisma.issue.findFirst({
        where: { projectId: (project as any).id, externalProvider: "gitlab", externalId },
      });

      const externalState = typeof payload.object_attributes.state === "string" ? payload.object_attributes.state : "";
      const externalLabels = normalizeGitLabLabels(payload.labels);
      const lastSyncedAt = new Date();

      if (!existing && !shouldCreate) {
        return { success: true, data: { ok: true, ignored: true, reason: "NOT_OPEN_ACTION", action } };
      }

      const externalUrl = payload.object_attributes.url ?? payload.project?.web_url ?? null;

      if (existing) {
        const nextStatus =
          action === "reopen" && ["done", "failed", "cancelled"].includes((existing as any).status) ? "pending" : undefined;

        const updated = await deps.prisma.issue.update({
          where: { id: (existing as any).id },
          data: {
            title: payload.object_attributes.title,
            description: payload.object_attributes.description ?? null,
            ...(nextStatus ? { status: nextStatus as any } : null),
            externalNumber: payload.object_attributes.iid,
            externalUrl,
            externalState,
            externalLabels,
            lastSyncedAt,
          } as any,
        });

        deps.onIssueUpserted?.((updated as any).id, `gitlab_webhook:${action || "update"}`);
        return { success: true, data: { ok: true, projectId: (project as any).id, issueId: (updated as any).id, created: false } };
      }

      try {
        const created = await deps.prisma.issue.create({
          data: {
            id: uuidv7(),
            projectId: (project as any).id,
            title: payload.object_attributes.title,
            description: payload.object_attributes.description ?? null,
            status: "pending",
            externalProvider: "gitlab",
            externalId,
            externalNumber: payload.object_attributes.iid,
            externalUrl,
            externalState,
            externalLabels,
            lastSyncedAt,
            createdBy: "gitlab_webhook",
          } as any,
        });

        deps.onIssueUpserted?.((created as any).id, `gitlab_webhook:${action || "open"}`);
        return { success: true, data: { ok: true, projectId: (project as any).id, issueId: (created as any).id, created: true } };
      } catch (err) {
        const again = await deps.prisma.issue.findFirst({
          where: { projectId: (project as any).id, externalProvider: "gitlab", externalId },
        });
        if (again) {
          deps.onIssueUpserted?.((again as any).id, `gitlab_webhook:${action || "open"}`);
          return { success: true, data: { ok: true, projectId: (project as any).id, issueId: (again as any).id, created: false } };
        }
        return { success: false, error: { code: "CREATE_FAILED", message: "写入 Issue 失败", details: String(err) } };
      }
    });
  };
}
