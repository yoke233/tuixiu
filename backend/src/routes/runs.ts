import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

import type { PrismaDeps, SendToAgent } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";
import { buildChatContextFromEvents } from "../modules/runs/runContext.js";
import { buildRecoveryInit } from "../modules/runs/runRecovery.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import {
  clientAcpPromptSchema,
  compactAcpPromptForEvent,
  type AcpContentBlock,
  type ClientAcpContentBlock,
} from "../modules/acp/acpContent.js";
import {
  createReviewRequestForRun,
  mergeReviewRequestForRun,
  syncReviewRequestForRun,
} from "../modules/scm/runReviewRequest.js";
import {
  requestCreatePrApproval,
  requestMergePrApproval,
} from "../modules/approvals/approvalRequests.js";
import {
  advanceTaskFromRunTerminal,
  setTaskBlockedFromRun,
} from "../modules/workflow/taskProgress.js";
import { triggerTaskAutoAdvance } from "../modules/workflow/taskAutoAdvance.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";
import { getPmPolicyFromBranchProtection } from "../modules/pm/pmPolicy.js";
import type { AttachmentStore } from "../modules/attachments/attachmentStore.js";
import type * as gitlab from "../integrations/gitlab.js";
import type * as github from "../integrations/github.js";

const execFileAsync = promisify(execFile);

export function makeRunRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  acp?: AcpTunnel;
  broadcastToClients?: (payload: unknown) => void;
  attachments?: AttachmentStore;
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

    server.get("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { issue: true, agent: true, artifacts: true },
      });
      if (!run) {
        return {
          success: false,
          error: { code: "NOT_FOUND", message: "Run 不存在" },
        };
      }
      return { success: true, data: { run } };
    });

    server.get("/:id/events", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const querySchema = z.object({
        limit: z.coerce.number().int().positive().max(500).default(200),
      });
      const { id } = paramsSchema.parse(request.params);
      const { limit } = querySchema.parse(request.query);

      const events = await deps.prisma.event.findMany({
        where: { runId: id },
        orderBy: { timestamp: "desc" },
        take: limit,
      });
      return { success: true, data: { events } };
    });

    server.post("/:id/attachments", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        mimeType: z.string().min(1),
        base64: z.string().min(1),
        name: z.string().min(1).max(500).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      if (!deps.attachments) {
        return {
          success: false,
          error: { code: "ATTACHMENTS_DISABLED", message: "附件存储未配置" },
        };
      }
      if (!body.mimeType.startsWith("image/")) {
        return {
          success: false,
          error: { code: "UNSUPPORTED_MIME", message: "本期仅支持图片上传" },
        };
      }

      const run = await deps.prisma.run.findUnique({ where: { id }, select: { id: true } });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      try {
        const attachment = await deps.attachments.putFromBase64({
          runId: id,
          mimeType: body.mimeType,
          base64: body.base64,
          name: body.name ?? null,
        });
        return { success: true, data: { attachment } };
      } catch (error) {
        const code = String((error as any)?.message ?? "");
        if (code === "FILE_TOO_LARGE") {
          return {
            success: false,
            error: {
              code: "FILE_TOO_LARGE",
              message: "文件过大",
              details: `maxBytes=${String((error as any)?.maxBytes ?? "")} size=${String((error as any)?.size ?? "")}`,
            },
          };
        }
        if (code === "EMPTY_FILE") {
          return { success: false, error: { code: "EMPTY_FILE", message: "文件为空" } };
        }
        return {
          success: false,
          error: { code: "UPLOAD_FAILED", message: "上传失败", details: String(error) },
        };
      }
    });

    server.get("/:id/attachments/:attachmentId", async (request, reply) => {
      const paramsSchema = z.object({
        id: z.string().uuid(),
        attachmentId: z.string().min(1).max(200),
      });
      const { id, attachmentId } = paramsSchema.parse(request.params);

      if (!deps.attachments) {
        reply.code(404);
        return {
          success: false,
          error: { code: "ATTACHMENTS_DISABLED", message: "附件存储未配置" },
        };
      }

      const info = await deps.attachments.getInfo({ runId: id, id: attachmentId });
      if (!info) {
        reply.code(404);
        return { success: false, error: { code: "NOT_FOUND", message: "附件不存在" } };
      }

      reply.header("content-length", String(info.size));
      reply.type(info.mimeType);
      return reply.send(createReadStream(info.filePath));
    });

    server.post("/:id/create-pr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        targetBranch: z.string().min(1).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { issue: { include: { project: true } } } as any,
      });
      if (!run) return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };

      const project = (run as any)?.issue?.project;
      if (!project)
        return { success: false, error: { code: "BAD_RUN", message: "Run 缺少 project" } };

      const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);
      const requireApproval = policy.approvals.requireForActions.includes("create_pr");

      if (requireApproval) {
        const req = await requestCreatePrApproval({
          prisma: deps.prisma,
          runId: id,
          requestedBy: "api_create_pr",
          payload: {
            title: body.title,
            description: body.description,
            targetBranch: body.targetBranch,
          },
        });
        if (!req.success) return req;

        return {
          success: false,
          error: {
            code: "APPROVAL_REQUIRED",
            message:
              "创建 PR 属于受控动作，需要审批。已创建审批请求，请在 /api/approvals 中批准后执行。",
          },
          data: req.data,
        };
      }

      return await createReviewRequestForRun(
        {
          prisma: deps.prisma,
          gitPush,
          gitlab: deps.gitlab,
          github: deps.github,
        },
        id,
        body,
      );
    });

    server.post("/:id/merge-pr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        requestedBy: z.string().min(1).max(100).optional(),
        squash: z.boolean().optional(),
        mergeCommitMessage: z.string().min(1).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const req = await requestMergePrApproval({
        prisma: deps.prisma,
        runId: id,
        requestedBy: body.requestedBy ?? "api_merge_pr",
        payload: { squash: body.squash, mergeCommitMessage: body.mergeCommitMessage },
      });
      if (!req.success) return req;

      return {
        success: false,
        error: {
          code: "APPROVAL_REQUIRED",
          message:
            "合并 PR 属于高危动作，需要审批。已创建审批请求，请在 /api/approvals 中批准后执行合并。",
        },
        data: req.data,
      };
    });

    server.post("/:id/request-merge-pr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        requestedBy: z.string().min(1).max(100).optional(),
        squash: z.boolean().optional(),
        mergeCommitMessage: z.string().min(1).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      return await requestMergePrApproval({
        prisma: deps.prisma,
        runId: id,
        requestedBy: body.requestedBy,
        payload: { squash: body.squash, mergeCommitMessage: body.mergeCommitMessage },
      });
    });

    server.post("/:id/sync-pr", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      return await syncReviewRequestForRun(
        {
          prisma: deps.prisma,
          gitPush,
          gitlab: deps.gitlab,
          github: deps.github,
        },
        id,
      );
    });

    server.post("/:id/prompt", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ prompt: clientAcpPromptSchema });
      const { id } = paramsSchema.parse(request.params);
      const { prompt: clientPrompt } = bodySchema.parse(request.body);

      const materializePrompt = async (
        prompt: readonly ClientAcpContentBlock[],
      ): Promise<AcpContentBlock[] | { error: any }> => {
        const out: AcpContentBlock[] = [];
        for (const block of prompt) {
          if (block.type !== "image") {
            out.push(block as any);
            continue;
          }

          const data = typeof block.data === "string" ? block.data.trim() : "";
          if (data) {
            out.push({ ...block, data } as any);
            continue;
          }

          const uri = typeof block.uri === "string" ? block.uri.trim() : "";
          if (!uri) {
            return { error: { code: "BAD_PROMPT", message: "image 缺少 data/uri" } };
          }
          if (!deps.attachments) {
            return {
              error: {
                code: "ATTACHMENTS_DISABLED",
                message: "附件存储未配置，无法从 uri 物化图片",
              },
            };
          }

          let attachmentId = "";
          try {
            const u = new URL(uri, "http://localhost");
            const parts = u.pathname.split("/").filter(Boolean);
            const runsIdx = parts.indexOf("runs");
            if (
              runsIdx >= 0 &&
              parts.length >= runsIdx + 4 &&
              parts[runsIdx + 2] === "attachments"
            ) {
              const runIdFromUri = parts[runsIdx + 1] ?? "";
              const attachmentFromUri = parts[runsIdx + 3] ?? "";
              if (runIdFromUri === id) attachmentId = attachmentFromUri;
            }
          } catch {
            // ignore
          }

          if (!attachmentId) {
            return {
              error: {
                code: "BAD_PROMPT",
                message: "image.uri 非法（仅支持 /runs/:id/attachments/:attachmentId）",
              },
            };
          }

          const bytes = await deps.attachments.getBytes({ runId: id, id: attachmentId });
          if (!bytes) {
            return { error: { code: "ATTACHMENT_NOT_FOUND", message: "图片附件不存在或不可读" } };
          }

          out.push({ ...block, data: bytes.toString("base64"), uri } as any);
        }
        return out;
      };

      const materialized = await materializePrompt(clientPrompt);
      if ((materialized as any)?.error) {
        return { success: false, error: (materialized as any).error };
      }
      const prompt = materialized as AcpContentBlock[];

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          agent: true,
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } },
        },
      });
      if (!run) {
        return {
          success: false,
          error: { code: "NOT_FOUND", message: "Run 不存在" },
        };
      }

      if (!deps.acp) {
        return {
          success: false,
          error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" },
        };
      }
      if (!run.agent) {
        return {
          success: false,
          error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法发送 prompt" },
        };
      }

      const sandboxStatus = typeof run.sandboxStatus === "string" ? run.sandboxStatus : "";
      let context: string | undefined;
      let init:
        | { script: string; timeout_seconds?: number; env?: Record<string, string> }
        | undefined;

      if (sandboxStatus === "missing") {
        const recentEvents = await deps.prisma.event.findMany({
          where: { runId: id },
          orderBy: { timestamp: "desc" },
          take: 200,
        });
        const chatContext = buildChatContextFromEvents(recentEvents);
        context = chatContext || undefined;
        init = (await buildRecoveryInit({
          prisma: deps.prisma,
          run,
          issue: run.issue,
          project: run.issue?.project,
        })) as any;
      }

      const cwd = run.workspacePath ?? "";
      if (!cwd) {
        return {
          success: false,
          error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法发送 prompt" },
        };
      }

      const createdAt = new Date();
      let eventPersisted = false;
      let createdEvent: any = null;
      try {
        createdEvent = await deps.prisma.event.create({
          data: {
            id: uuidv7(),
            runId: id,
            source: "user",
            type: "user.message",
            payload: { prompt: compactAcpPromptForEvent(prompt) } as any,
            timestamp: createdAt,
          },
        });
        eventPersisted = true;
        if (createdEvent) {
          deps.broadcastToClients?.({ type: "event_added", run_id: id, event: createdEvent });
        }
      } catch (error) {
        server.log.warn({ err: error, runId: id }, "persist user.message failed before prompt");
      }

      try {
        await deps.acp.promptRun({
          proxyId: run.agent.proxyId,
          runId: id,
          cwd,
          sessionId: run.acpSessionId ?? null,
          context,
          prompt,
          init,
        });
      } catch (error) {
        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送消息到 Agent 失败",
            details: String(error),
          },
          ...(eventPersisted
            ? {}
            : {
                warning: {
                  code: "EVENT_PERSIST_FAILED",
                  message: "消息发送失败且写入事件失败",
                },
              }),
        };
      }

      if (!eventPersisted) {
        return {
          success: true,
          data: {
            ok: true,
            warning: { code: "EVENT_PERSIST_FAILED", message: "消息已发送，但写入事件失败" },
          },
        };
      }

      return { success: true, data: { ok: true } };
    });

    server.post("/:id/submit", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        verdict: z.enum(["approve", "changes_requested"]),
        comment: z.string().max(20_000).optional(),
        squash: z.boolean().optional(),
        mergeCommitMessage: z.string().min(1).max(2000).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          step: true,
          task: { include: { steps: { orderBy: { order: "asc" } } } },
          issue: { include: { project: true } },
          artifacts: { orderBy: { createdAt: "desc" } },
        },
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }

      if (run.executorType !== "human") {
        return {
          success: false,
          error: { code: "BAD_EXECUTOR", message: "该 Run 不是 human executor" },
        };
      }

      const stepKind = typeof (run as any).step?.kind === "string" ? (run as any).step.kind : "";
      const actorRole = String(((request as any).user as any)?.role ?? "");
      if (actorRole) {
        const allow =
          stepKind === "code.review" || stepKind === "pr.merge"
            ? ["reviewer", "admin"].includes(actorRole)
            : stepKind === "prd.review"
              ? ["pm", "admin"].includes(actorRole)
              : ["dev", "pm", "reviewer", "admin"].includes(actorRole);
        if (!allow) {
          return { success: false, error: { code: "FORBIDDEN", message: "无权限提交该步骤" } };
        }
      }
      const verdict = body.verdict;
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";

      const reportKind =
        stepKind === "code.review"
          ? "review"
          : stepKind === "prd.review"
            ? "prd_review"
            : stepKind === "pr.merge"
              ? "merge"
              : stepKind || "human";

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId: run.id,
            source: "user",
            type: "human.step.submitted",
            payload: { kind: reportKind, verdict, markdown: comment || null } as any,
          } as any,
        })
        .catch(() => {});

      if (stepKind === "pr.merge") {
        const mergeRes = await mergeReviewRequestForRun(
          { prisma: deps.prisma, gitPush, gitlab: deps.gitlab, github: deps.github },
          run.id,
          { squash: body.squash, mergeCommitMessage: body.mergeCommitMessage },
        );
        if (!mergeRes.success) return mergeRes;

        await deps.prisma.run
          .update({
            where: { id: run.id },
            data: { status: "completed", completedAt: new Date() } as any,
          })
          .catch(() => {});
        await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(
          () => {},
        );
        if ((run as any).taskId) {
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: run.id,
          });
          triggerTaskAutoAdvance(
            {
              prisma: deps.prisma,
              sendToAgent: deps.sendToAgent,
              acp: deps.acp,
              broadcastToClients: deps.broadcastToClients,
            },
            {
              issueId: (run as any).issueId,
              taskId: (run as any).taskId,
              trigger: "step_completed",
            },
          );
        }
        return { success: true, data: { ok: true } };
      }

      await deps.prisma.run
        .update({
          where: { id: run.id },
          data: { status: "completed", completedAt: new Date() } as any,
        })
        .catch(() => {});

      if (verdict === "changes_requested") {
        if ((run as any).stepId) {
          await deps.prisma.step
            .update({ where: { id: (run as any).stepId }, data: { status: "completed" } as any })
            .catch(() => {});
        }
        await setTaskBlockedFromRun({ prisma: deps.prisma }, run.id, {
          code: "CHANGES_REQUESTED",
          message: comment || "changes requested",
        }).catch(() => {});
        if ((run as any).taskId) {
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: run.id,
            reason: "changes_requested",
          });
        }
        return { success: true, data: { ok: true, blocked: true } };
      }

      await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(
        () => {},
      );
      if ((run as any).taskId) {
        deps.broadcastToClients?.({
          type: "task_updated",
          issue_id: (run as any).issueId,
          task_id: (run as any).taskId,
          step_id: (run as any).stepId,
          run_id: run.id,
        });
        triggerTaskAutoAdvance(
          {
            prisma: deps.prisma,
            sendToAgent: deps.sendToAgent,
            acp: deps.acp,
            broadcastToClients: deps.broadcastToClients,
          },
          { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "step_completed" },
        );
      }
      return { success: true, data: { ok: true } };
    });

    server.post("/:id/pause", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { agent: true },
      });
      if (!run) {
        return {
          success: false,
          error: { code: "NOT_FOUND", message: "Run 不存在" },
        };
      }

      if (!deps.acp) {
        return {
          success: false,
          error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" },
        };
      }
      if (!run.agent) {
        return {
          success: false,
          error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法暂停" },
        };
      }

      if (!run.acpSessionId) {
        return {
          success: false,
          error: { code: "NO_ACP_SESSION", message: "ACP session 尚未建立，无法暂停" },
        };
      }

      try {
        await deps.acp.cancelSession({
          proxyId: run.agent.proxyId,
          runId: id,
          cwd: "/workspace",
          sessionId: run.acpSessionId,
        });
      } catch (error) {
        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送暂停到 Agent 失败",
            details: String(error),
          },
        };
      }

      return { success: true, data: { ok: true } };
    });

    server.post("/:id/cancel", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.update({
        where: { id },
        data: { status: "cancelled", completedAt: new Date() },
        include: { agent: { select: { proxyId: true } } },
      });

      if (deps.acp) {
        const proxyId = run.agent?.proxyId ?? null;
        const sessionId = run.acpSessionId ?? null;
        if (proxyId && sessionId) {
          await deps.acp
            .cancelSession({ proxyId, runId: id, cwd: "/workspace", sessionId })
            .catch(() => {});
        }
      }

      await deps.prisma.issue
        .update({ where: { id: run.issueId }, data: { status: "cancelled" } })
        .catch(() => {});
      if (run.agentId) {
        await deps.prisma.agent
          .update({
            where: { id: run.agentId },
            data: { currentLoad: { decrement: 1 } },
          })
          .catch(() => {});
      }

      return { success: true, data: { run } };
    });

    server.post("/:id/complete", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.update({
        where: { id },
        data: { status: "completed", completedAt: new Date() },
      });

      await deps.prisma.issue
        .update({ where: { id: run.issueId }, data: { status: "reviewing" } })
        .catch(() => {});
      if (run.agentId) {
        await deps.prisma.agent
          .update({
            where: { id: run.agentId },
            data: { currentLoad: { decrement: 1 } },
          })
          .catch(() => {});
      }

      return { success: true, data: { run } };
    });
  };
}
