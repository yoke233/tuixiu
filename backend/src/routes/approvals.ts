import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps, SendToAgent } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";
import { toApprovalSummary, type ApprovalStatus } from "../modules/approvals/approvalRequests.js";
import type { CreateWorkspace } from "../executors/types.js";
import { mergeReviewRequestForRun, createReviewRequestForRun } from "../modules/scm/runReviewRequest.js";
import { postGitHubApprovalCommentBestEffort } from "../modules/scm/githubIssueComments.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";
import { publishArtifact } from "../modules/artifacts/artifactPublish.js";
import { advanceTaskFromRunTerminal } from "../modules/workflow/taskProgress.js";
import { triggerTaskAutoAdvance } from "../modules/workflow/taskAutoAdvance.js";

import type * as gitlab from "../integrations/gitlab.js";
import type * as github from "../integrations/github.js";

const execFileAsync = promisify(execFile);

function normalizeApprovalStatus(value: string | undefined): ApprovalStatus | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  const allowed: ApprovalStatus[] = ["pending", "approved", "rejected", "executing", "executed", "failed"];
  return allowed.includes(v as ApprovalStatus) ? (v as ApprovalStatus) : null;
}

export function makeApprovalRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  createWorkspace?: CreateWorkspace;
  broadcastToClients?: (payload: unknown) => void;
  gitPush?: (opts: { cwd: string; branch: string; project: any }) => Promise<void>;
  gitlab?: {
    inferBaseUrl?: typeof gitlab.inferGitlabBaseUrl;
    createMergeRequest?: typeof gitlab.createMergeRequest;
    mergeMergeRequest?: typeof gitlab.mergeMergeRequest;
    getMergeRequest?: typeof gitlab.getMergeRequest;
  };
  github?: {
    parseRepo?: typeof github.parseGitHubRepo;
    createPullRequest?: typeof github.createPullRequest;
    mergePullRequest?: typeof github.mergePullRequest;
    getPullRequest?: typeof github.getPullRequest;
  };
}): FastifyPluginAsync {
  return async (server) => {
    const gitPush =
      deps.gitPush ??
      (async (opts: { cwd: string; branch: string; project: any }) => {
        const { env, cleanup } = await createGitProcessEnv(opts.project);
        try {
          await execFileAsync("git", ["push", "-u", "origin", opts.branch], {
            cwd: opts.cwd,
            env,
          });
        } finally {
          await cleanup();
        }
      });

    server.get("/", async (request) => {
      const querySchema = z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
      });
      const { status, limit } = querySchema.parse(request.query);
      const wanted = normalizeApprovalStatus(status ?? undefined);

      const rows = await deps.prisma.approval.findMany({
        where: wanted ? ({ status: wanted } as any) : ({} as any),
        orderBy: { createdAt: "desc" } as any,
        take: limit,
        include: { run: { include: { issue: true } } } as any,
      });

      const approvals = rows
        .map((a: any) => toApprovalSummary(a, a?.run))
        .filter((x: any): x is NonNullable<typeof x> => Boolean(x));

      return { success: true, data: { approvals } };
    });

    server.post("/:id/approve", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        actor: z.string().min(1).max(100).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const { actor } = bodySchema.parse(request.body ?? {});

      const approval = await deps.prisma.approval.findUnique({ where: { id } } as any);
      if (!approval) return { success: false, error: { code: "NOT_FOUND", message: "审批请求不存在" } };
      if (String((approval as any).status) !== "pending") {
        return { success: false, error: { code: "NOT_PENDING", message: "该审批请求不是 pending 状态" } };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const decidedBy = typeof actor === "string" && actor.trim() ? actor.trim() : "user";

      await deps.prisma.approval.update({
        where: { id } as any,
        data: { status: "executing" as any, decidedBy, decidedAt: now } as any,
      });

      const run = await deps.prisma.run.findUnique({
        where: { id: String((approval as any).runId) },
        include: { issue: { include: { project: true } }, artifacts: { orderBy: { createdAt: "desc" } } } as any,
      });
      if (!run) return { success: false, error: { code: "NO_RUN", message: "找不到该审批对应的 Run" } };

      const issue: any = (run as any).issue;
      const project: any = issue?.project;
      const issueIsGitHub = String(issue?.externalProvider ?? "").toLowerCase() === "github";
      const issueNumber = Number(issue?.externalNumber ?? 0);
      const token = String(project?.githubAccessToken ?? "").trim();
      const repoUrl = String(project?.repoUrl ?? "").trim();

      const action = String((approval as any).action ?? "").trim();

      if (action === "merge_pr") {
        const prUrl = typeof (run as any).scmPrUrl === "string" ? String((run as any).scmPrUrl).trim() : "";

        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: "approval.merge_pr.approved",
              payload: { approvalId: id, decidedBy, decidedAt: nowIso, prUrl: prUrl || undefined } as any,
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: "merge_pr_approved",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
            prUrl: prUrl || null,
          });
        }

        const payload = ((approval as any).payload ?? {}) as any;
        const mergeBody = {
          squash: typeof payload?.squash === "boolean" ? payload.squash : undefined,
          mergeCommitMessage: typeof payload?.mergeCommitMessage === "string" ? payload.mergeCommitMessage : undefined,
        };

        const mergeRes = await mergeReviewRequestForRun(
          { prisma: deps.prisma, gitPush, gitlab: deps.gitlab, github: deps.github },
          String((run as any).id),
          mergeBody,
        );

        const updated = await deps.prisma.approval.update({
          where: { id } as any,
          data: mergeRes.success
            ? ({ status: "executed", result: { ok: true, mergedAt: nowIso } } as any)
            : ({ status: "failed", result: { ok: false, mergedAt: nowIso, error: mergeRes.error } } as any),
        });

        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: mergeRes.success ? "approval.merge_pr.executed" : "approval.merge_pr.failed",
              payload: mergeRes.success
                ? ({ approvalId: id, decidedBy, mergedAt: nowIso, prUrl: prUrl || undefined } as any)
                : ({ approvalId: id, decidedBy, mergedAt: nowIso, prUrl: prUrl || undefined, error: mergeRes.error } as any),
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: mergeRes.success ? "merge_pr_executed" : "merge_pr_failed",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
            prUrl: prUrl || null,
            error: mergeRes.success ? null : String(mergeRes.error?.message ?? ""),
          });
        }

        const summary = toApprovalSummary(updated, run);
        if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };

        if (!mergeRes.success) return { success: false, error: mergeRes.error, data: { approval: summary } };
        return { success: true, data: { approval: summary, pr: (mergeRes as any).data?.pr } };
      }

      if (action === "create_pr") {
        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: "approval.create_pr.approved",
              payload: { approvalId: id, decidedBy, decidedAt: nowIso } as any,
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: "create_pr_approved",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
          });
        }

        const payload = ((approval as any).payload ?? {}) as any;
        const createBody = {
          title: typeof payload?.title === "string" ? payload.title : undefined,
          description: typeof payload?.description === "string" ? payload.description : undefined,
          targetBranch: typeof payload?.targetBranch === "string" ? payload.targetBranch : undefined,
        };

        const createRes = await createReviewRequestForRun(
          { prisma: deps.prisma, gitPush, gitlab: deps.gitlab, github: deps.github },
          String((run as any).id),
          createBody,
          (run as any).taskId ? { setRunWaitingCi: false } : undefined,
        );

        const pr = createRes.success ? (createRes as any).data?.pr : null;
        const prUrl = typeof pr?.url === "string" ? String(pr.url).trim() : typeof pr?.webUrl === "string" ? String(pr.webUrl).trim() : "";

        const updated = await deps.prisma.approval.update({
          where: { id } as any,
          data: createRes.success
            ? ({ status: "executed", result: { ok: true, prUrl: prUrl || undefined, createdAt: nowIso } } as any)
            : ({ status: "failed", result: { ok: false, createdAt: nowIso, error: createRes.error } } as any),
        });

        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: createRes.success ? "approval.create_pr.executed" : "approval.create_pr.failed",
              payload: createRes.success
                ? ({ approvalId: id, decidedBy, createdAt: nowIso, prUrl: prUrl || undefined } as any)
                : ({ approvalId: id, decidedBy, createdAt: nowIso, error: createRes.error } as any),
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: createRes.success ? "create_pr_executed" : "create_pr_failed",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
            prUrl: prUrl || null,
            error: createRes.success ? null : String((createRes as any)?.error?.message ?? ""),
          });
        }

        const summary = toApprovalSummary(updated, run);
        if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };

        if (!createRes.success) {
          if ((run as any).taskId) {
            await deps.prisma.run
              .update({
                where: { id: String((run as any).id) },
                data: { status: "failed", completedAt: new Date(), failureReason: "approval_action_failed" } as any,
              })
              .catch(() => {});
            await advanceTaskFromRunTerminal({ prisma: deps.prisma }, String((run as any).id), "failed", {
              errorMessage: String((createRes as any)?.error?.message ?? "create pr failed"),
            }).catch(() => {});
            deps.broadcastToClients?.({
              type: "task_updated",
              issue_id: (run as any).issueId,
              task_id: (run as any).taskId,
              step_id: (run as any).stepId,
              run_id: String((run as any).id),
              reason: "approval_action_failed",
            });
          }
          return { success: false, error: createRes.error!, data: { approval: summary } };
        }

        if ((run as any).taskId) {
          await deps.prisma.run
            .update({ where: { id: String((run as any).id) }, data: { status: "completed", completedAt: new Date() } as any })
            .catch(() => {});
          await advanceTaskFromRunTerminal({ prisma: deps.prisma }, String((run as any).id), "completed").catch(() => {});
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: String((run as any).id),
          });
          triggerTaskAutoAdvance(
            { prisma: deps.prisma, sendToAgent: deps.sendToAgent, createWorkspace: deps.createWorkspace, broadcastToClients: deps.broadcastToClients },
            { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "step_completed" },
          );
        }

        return { success: true, data: { approval: summary, pr } };
      }

      if (action === "publish_artifact") {
        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: "approval.publish_artifact.approved",
              payload: { approvalId: id, decidedBy, decidedAt: nowIso } as any,
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: "publish_artifact_approved",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
          });
        }

        const payload = ((approval as any).payload ?? {}) as any;
        const sourceArtifactId = typeof payload?.sourceArtifactId === "string" ? payload.sourceArtifactId : "";
        const desiredPath = typeof payload?.path === "string" ? payload.path : undefined;
        if (!sourceArtifactId) {
          return { success: false, error: { code: "BAD_PAYLOAD", message: "publish_artifact 缺少 sourceArtifactId" } };
        }

        const publishRes = await publishArtifact({ prisma: deps.prisma }, sourceArtifactId, { path: desiredPath });

        const updated = await deps.prisma.approval.update({
          where: { id } as any,
          data: publishRes.success
            ? ({ status: "executed", result: { ok: true, publishedAt: nowIso, ...publishRes.data } } as any)
            : ({ status: "failed", result: { ok: false, publishedAt: nowIso, error: (publishRes as any).error } } as any),
        });

        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "system",
              type: publishRes.success ? "approval.publish_artifact.executed" : "approval.publish_artifact.failed",
              payload: publishRes.success
                ? ({ approvalId: id, decidedBy, publishedAt: nowIso, ...publishRes.data } as any)
                : ({ approvalId: id, decidedBy, publishedAt: nowIso, error: (publishRes as any).error } as any),
            } as any,
          })
          .catch(() => {});

        if (issueIsGitHub && token) {
          await postGitHubApprovalCommentBestEffort({
            prisma: deps.prisma,
            projectId: issue?.projectId ?? null,
            repoUrl,
            githubAccessToken: token,
            issueNumber,
            kind: publishRes.success ? "publish_artifact_executed" : "publish_artifact_failed",
            runId: String((run as any).id),
            approvalId: id,
            actor: decidedBy,
            error: publishRes.success ? null : String((publishRes as any)?.error?.message ?? ""),
          });
        }

        const summary = toApprovalSummary(updated, run);
        if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };

        if (!publishRes.success) return { success: false, error: (publishRes as any).error, data: { approval: summary } };

        if ((run as any).taskId) {
          await deps.prisma.run
            .update({ where: { id: String((run as any).id) }, data: { status: "completed", completedAt: new Date() } as any })
            .catch(() => {});
          await advanceTaskFromRunTerminal({ prisma: deps.prisma }, String((run as any).id), "completed").catch(() => {});
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: String((run as any).id),
          });
          triggerTaskAutoAdvance(
            { prisma: deps.prisma, sendToAgent: deps.sendToAgent, createWorkspace: deps.createWorkspace, broadcastToClients: deps.broadcastToClients },
            { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "step_completed" },
          );
        }

        return { success: true, data: { approval: summary, ...publishRes.data } };
      }

      return { success: false, error: { code: "UNSUPPORTED_ACTION", message: "暂不支持该审批动作" } };
    });

    server.post("/:id/reject", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        actor: z.string().min(1).max(100).optional(),
        reason: z.string().min(1).max(500).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const { actor, reason } = bodySchema.parse(request.body ?? {});

      const approval = await deps.prisma.approval.findUnique({ where: { id } } as any);
      if (!approval) return { success: false, error: { code: "NOT_FOUND", message: "审批请求不存在" } };
      if (String((approval as any).status) !== "pending") {
        return { success: false, error: { code: "NOT_PENDING", message: "该审批请求不是 pending 状态" } };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const decidedBy = typeof actor === "string" && actor.trim() ? actor.trim() : "user";

      const updated = await deps.prisma.approval.update({
        where: { id } as any,
        data: { status: "rejected" as any, decidedBy, decidedAt: now, reason: typeof reason === "string" ? reason : null } as any,
      });

      const run = await deps.prisma.run.findUnique({
        where: { id: String((approval as any).runId) },
        include: { issue: { include: { project: true } } } as any,
      });
      if (!run) return { success: false, error: { code: "NO_RUN", message: "找不到该审批对应的 Run" } };

      const action = String((approval as any).action ?? "").trim();
      const prUrl = typeof (run as any).scmPrUrl === "string" ? String((run as any).scmPrUrl).trim() : "";

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId: String((run as any).id),
            source: "system",
            type:
              action === "merge_pr"
                ? "approval.merge_pr.rejected"
                : action === "create_pr"
                  ? "approval.create_pr.rejected"
                  : "approval.publish_artifact.rejected",
            payload: { approvalId: id, decidedBy, decidedAt: nowIso, reason: (updated as any).reason ?? undefined, prUrl: prUrl || undefined } as any,
          } as any,
        })
        .catch(() => {});

      const issue: any = (run as any).issue;
      const project: any = issue?.project;
      const issueIsGitHub = String(issue?.externalProvider ?? "").toLowerCase() === "github";
      const issueNumber = Number(issue?.externalNumber ?? 0);
      const token = String(project?.githubAccessToken ?? "").trim();
      const repoUrl = String(project?.repoUrl ?? "").trim();

      if (issueIsGitHub && token) {
        await postGitHubApprovalCommentBestEffort({
          prisma: deps.prisma,
          projectId: issue?.projectId ?? null,
          repoUrl,
          githubAccessToken: token,
          issueNumber,
          kind:
            action === "merge_pr"
              ? "merge_pr_rejected"
              : action === "create_pr"
                ? "create_pr_rejected"
                : "publish_artifact_rejected",
          runId: String((run as any).id),
          approvalId: id,
          actor: decidedBy,
          prUrl: prUrl || null,
          reason: typeof (updated as any).reason === "string" ? (updated as any).reason : null,
        });
      }

      if ((run as any).taskId && (run as any).stepId && action !== "merge_pr") {
        await deps.prisma.run
          .update({ where: { id: String((run as any).id) }, data: { status: "completed", completedAt: new Date() } as any })
          .catch(() => {});
        await deps.prisma.step.update({ where: { id: (run as any).stepId }, data: { status: "blocked" } as any }).catch(() => {});
        await deps.prisma.task.update({ where: { id: (run as any).taskId }, data: { status: "blocked" } as any }).catch(() => {});
        await deps.prisma.issue.update({ where: { id: (run as any).issueId }, data: { status: "reviewing" } as any }).catch(() => {});

        deps.broadcastToClients?.({
          type: "task_updated",
          issue_id: (run as any).issueId,
          task_id: (run as any).taskId,
          step_id: (run as any).stepId,
          run_id: String((run as any).id),
          reason: "approval_rejected",
        });
      }

      const summary = toApprovalSummary(updated, run);
      if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };
      return { success: true, data: { approval: summary } };
    });
  };
}
