import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { buildContextFromRun } from "../services/runContext.js";
import type { AcpTunnel } from "../services/acpTunnel.js";
import {
  getRunChanges,
  getRunDiff,
  RunGitChangeError,
} from "../services/runGitChanges.js";
import {
  createReviewRequestForRun,
  mergeReviewRequestForRun,
  syncReviewRequestForRun,
} from "../services/runReviewRequest.js";
import { requestMergePrApproval } from "../services/approvalRequests.js";
import { advanceTaskFromRunTerminal, setTaskBlockedFromRun } from "../services/taskProgress.js";
import { triggerTaskAutoAdvance } from "../services/taskAutoAdvance.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";
import type * as gitlab from "../integrations/gitlab.js";
import type * as github from "../integrations/github.js";

const execFileAsync = promisify(execFile);

export function makeRunRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  acp?: AcpTunnel;
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

    server.get("/:id/changes", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      try {
        const data = await getRunChanges({ prisma: deps.prisma, runId: id });
        return { success: true, data };
      } catch (err) {
        if (err instanceof RunGitChangeError) {
          if (err.code === "NOT_FOUND") {
            return {
              success: false,
              error: { code: "NOT_FOUND", message: err.message },
            };
          }
          if (err.code === "NO_BRANCH") {
            return {
              success: false,
              error: { code: "NO_BRANCH", message: err.message },
            };
          }
          return {
            success: false,
            error: {
              code: "GIT_DIFF_FAILED",
              message: err.message,
              details: err.details,
            },
          };
        }
        return {
          success: false,
          error: {
            code: "GIT_DIFF_FAILED",
            message: "获取变更失败",
            details: String(err),
          },
        };
      }
    });

    server.get("/:id/diff", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const querySchema = z.object({ path: z.string().min(1) });
      const { id } = paramsSchema.parse(request.params);
      const { path } = querySchema.parse(request.query);

      try {
        const data = await getRunDiff({ prisma: deps.prisma, runId: id, path });
        return { success: true, data };
      } catch (err) {
        if (err instanceof RunGitChangeError) {
          if (err.code === "NOT_FOUND") {
            return {
              success: false,
              error: { code: "NOT_FOUND", message: err.message },
            };
          }
          if (err.code === "NO_BRANCH") {
            return {
              success: false,
              error: { code: "NO_BRANCH", message: err.message },
            };
          }
          return {
            success: false,
            error: {
              code: "GIT_DIFF_FAILED",
              message: err.message,
              details: err.details,
            },
          };
        }
        return {
          success: false,
          error: {
            code: "GIT_DIFF_FAILED",
            message: "获取 diff 失败",
            details: String(err),
          },
        };
      }
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
          message: "合并 PR 属于高危动作，需要审批。已创建审批请求，请在 /api/approvals 中批准后执行合并。",
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
      const bodySchema = z.object({ text: z.string().min(1) });
      const { id } = paramsSchema.parse(request.params);
      const { text } = bodySchema.parse(request.body);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: {
          agent: true,
          issue: true,
          artifacts: { orderBy: { createdAt: "desc" } },
        },
      });
      if (!run) {
        return {
          success: false,
          error: { code: "NOT_FOUND", message: "Run 不存在" },
        };
      }

      await deps.prisma.event.create({
        data: {
          id: uuidv7(),
          runId: id,
          source: "user",
          type: "user.message",
          payload: { text } as any,
        },
      });

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

      try {
        const recentEvents = await deps.prisma.event.findMany({
          where: { runId: id },
          orderBy: { timestamp: "desc" },
          take: 200,
        });
        const context = buildContextFromRun({
          run,
          issue: run.issue,
          events: recentEvents,
        });

        const cwd = run.workspacePath ?? "";
        if (!cwd) {
          return {
            success: false,
            error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法发送 prompt" },
          };
        }

        await deps.acp.promptRun({
          proxyId: run.agent.proxyId,
          runId: id,
          cwd,
          sessionId: run.acpSessionId ?? null,
          context,
          prompt: text,
        });
      } catch (error) {
        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送消息到 Agent 失败",
            details: String(error),
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
        return { success: false, error: { code: "BAD_EXECUTOR", message: "该 Run 不是 human executor" } };
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

      await deps.prisma.artifact
        .create({
          data: {
            id: uuidv7(),
            runId: run.id,
            type: "report",
            content: { kind: reportKind, verdict, markdown: comment } as any,
          },
        })
        .catch(() => {});

      if (stepKind === "pr.merge") {
        const mergeRes = await mergeReviewRequestForRun(
          { prisma: deps.prisma, gitPush, gitlab: deps.gitlab, github: deps.github },
          run.id,
          { squash: body.squash, mergeCommitMessage: body.mergeCommitMessage },
        );
        if (!mergeRes.success) return mergeRes;

        await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed", completedAt: new Date() } as any }).catch(() => {});
        await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(() => {});
        if ((run as any).taskId) {
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: (run as any).issueId,
            task_id: (run as any).taskId,
            step_id: (run as any).stepId,
            run_id: run.id,
          });
          triggerTaskAutoAdvance(
            { prisma: deps.prisma, sendToAgent: deps.sendToAgent, acp: deps.acp, broadcastToClients: deps.broadcastToClients },
            { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "step_completed" },
          );
        }
        return { success: true, data: { ok: true } };
      }

      await deps.prisma.run.update({ where: { id: run.id }, data: { status: "completed", completedAt: new Date() } as any }).catch(() => {});

      if (verdict === "changes_requested") {
        if ((run as any).stepId) {
          await deps.prisma.step
            .update({ where: { id: (run as any).stepId }, data: { status: "completed" } as any })
            .catch(() => {});
        }
        await setTaskBlockedFromRun(
          { prisma: deps.prisma },
          run.id,
          { code: "CHANGES_REQUESTED", message: comment || "changes requested" },
        ).catch(() => {});
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

      await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(() => {});
      if ((run as any).taskId) {
        deps.broadcastToClients?.({
          type: "task_updated",
          issue_id: (run as any).issueId,
          task_id: (run as any).taskId,
          step_id: (run as any).stepId,
          run_id: run.id,
        });
        triggerTaskAutoAdvance(
          { prisma: deps.prisma, sendToAgent: deps.sendToAgent, acp: deps.acp, broadcastToClients: deps.broadcastToClients },
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

      const cwd = run.workspacePath ?? "";
      if (!cwd) {
        return { success: false, error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法暂停" } };
      }

      try {
        await deps.acp.cancelSession({
          proxyId: run.agent.proxyId,
          runId: id,
          cwd,
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
        const cwd = run.workspacePath ?? "";
        if (proxyId && sessionId && cwd) {
          await deps.acp.cancelSession({ proxyId, runId: id, cwd, sessionId }).catch(() => {});
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
