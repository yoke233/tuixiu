import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { buildContextFromRun } from "../services/runContext.js";
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
import type * as gitlab from "../integrations/gitlab.js";
import type * as github from "../integrations/github.js";

const execFileAsync = promisify(execFile);

export function makeRunRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  gitPush?: (opts: { cwd: string; branch: string }) => Promise<void>;
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
      (async (opts: { cwd: string; branch: string }) => {
        await execFileAsync("git", ["push", "-u", "origin", opts.branch], {
          cwd: opts.cwd,
        });
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
        squash: z.boolean().optional(),
        mergeCommitMessage: z.string().min(1).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      return await mergeReviewRequestForRun(
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

      if (!deps.sendToAgent) {
        return {
          success: false,
          error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" },
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

        await deps.sendToAgent(run.agent.proxyId, {
          type: "prompt_run",
          run_id: id,
          prompt: text,
          session_id: run.acpSessionId ?? undefined,
          context,
          cwd: run.workspacePath ?? undefined,
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

      if (!deps.sendToAgent) {
        return {
          success: false,
          error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" },
        };
      }

      if (!run.acpSessionId) {
        return {
          success: false,
          error: { code: "NO_ACP_SESSION", message: "ACP session 尚未建立，无法暂停" },
        };
      }

      try {
        await deps.sendToAgent(run.agent.proxyId, {
          type: "session_cancel",
          run_id: id,
          session_id: run.acpSessionId,
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

      if (deps.sendToAgent) {
        await deps.sendToAgent(run.agent.proxyId, {
          type: "cancel_task",
          run_id: id,
          session_id: run.acpSessionId ?? undefined,
        }).catch(() => {});
      }

      await deps.prisma.issue
        .update({ where: { id: run.issueId }, data: { status: "cancelled" } })
        .catch(() => {});
      await deps.prisma.agent
        .update({
          where: { id: run.agentId },
          data: { currentLoad: { decrement: 1 } },
        })
        .catch(() => {});

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
      await deps.prisma.agent
        .update({
          where: { id: run.agentId },
          data: { currentLoad: { decrement: 1 } },
        })
        .catch(() => {});

      return { success: true, data: { run } };
    });
  };
}
