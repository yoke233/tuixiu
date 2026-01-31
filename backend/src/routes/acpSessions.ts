import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps, SendToAgent } from "../db.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import type { CreateWorkspace } from "../executors/types.js";
import { dispatchExecutionForRun } from "../modules/workflow/executionDispatch.js";
import { TaskEngineError, createTaskFromTemplate, startStep } from "../modules/workflow/taskEngine.js";
import { uuidv7 } from "../utils/uuid.js";
import { getSandboxWorkspaceMode } from "../utils/sandboxCaps.js";
import { resolveAgentWorkspaceCwd } from "../utils/agentWorkspaceCwd.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function upsertAcpSessionStateInRunMetadata(opts: {
  runMetadata: unknown;
  sessionId: string;
  patch: Partial<{
    activity: string;
    inFlight: number;
    updatedAt: string;
    currentModeId: string | null;
    currentModelId: string | null;
    lastStopReason: string | null;
    note: string | null;
  }>;
}): unknown {
  const now = new Date().toISOString();
  const root = isRecord(opts.runMetadata) ? { ...(opts.runMetadata as any) } : {};
  const existing =
    isRecord((root as any).acpSessionState) &&
    typeof (root as any).acpSessionState.sessionId === "string" &&
    (root as any).acpSessionState.sessionId === opts.sessionId
      ? ((root as any).acpSessionState as any)
      : null;

  (root as any).acpSessionState = {
    sessionId: opts.sessionId,
    activity: existing?.activity ?? "unknown",
    inFlight: typeof existing?.inFlight === "number" ? existing.inFlight : 0,
    updatedAt: typeof existing?.updatedAt === "string" ? existing.updatedAt : now,
    currentModeId: typeof existing?.currentModeId === "string" ? existing.currentModeId : null,
    currentModelId: typeof existing?.currentModelId === "string" ? existing.currentModelId : null,
    lastStopReason: typeof existing?.lastStopReason === "string" ? existing.lastStopReason : null,
    note: typeof existing?.note === "string" ? existing.note : null,
    ...opts.patch,
  };

  return root;
}

export function makeAcpSessionRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  acp?: AcpTunnel;
  createWorkspace?: CreateWorkspace;
  broadcastToClients?: (payload: unknown) => void;
  sandboxGitPush?: (opts: { run: any; branch: string; project: any }) => Promise<void>;
  auth: AuthHelpers;
}): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get(
      "/acp-sessions",
      { preHandler: requireAdmin },
      async (request) => {
        const querySchema = z.object({
          projectId: z.string().uuid().optional(),
          limit: z.coerce.number().int().positive().max(500).default(200),
        });
        const { projectId, limit } = querySchema.parse(request.query);

        const issueWhere: Record<string, unknown> = { archivedAt: null };
        if (projectId) {
          issueWhere.projectId = projectId;
        }

        const where: Record<string, unknown> = {
          executorType: "agent",
          acpSessionId: { not: null },
          issue: issueWhere,
        };

        const runs = await deps.prisma.run.findMany({
          where: where as any,
          orderBy: { startedAt: "desc" },
          take: limit,
          include: { issue: true, agent: true } as any,
        } as any);

        const sessions = (runs as any[]).map((run) => ({
          runId: run.id,
          issueId: run.issueId,
          issueTitle: run.issue?.title ?? "",
          projectId: run.issue?.projectId ?? "",
          runStatus: run.status,
          sessionId: run.acpSessionId,
          sessionState:
            isRecord(run.metadata) &&
            isRecord((run.metadata as any).acpSessionState) &&
            (run.metadata as any).acpSessionState.sessionId === run.acpSessionId
              ? (run.metadata as any).acpSessionState
              : {
                  sessionId: run.acpSessionId,
                  activity: "unknown",
                  inFlight: 0,
                  updatedAt: (run.completedAt ?? run.startedAt ?? new Date()).toISOString(),
                  currentModeId: null,
                  currentModelId: null,
                  lastStopReason: null,
                  note: "no_state",
                },
          startedAt: run.startedAt,
          completedAt: run.completedAt ?? null,
          agent: run.agent
            ? {
                id: run.agent.id,
                name: run.agent.name,
                proxyId: run.agent.proxyId,
                status: run.agent.status,
              }
            : null,
        }));

        return { success: true, data: { sessions } };
      },
    );

    server.post(
      "/acp-sessions/start",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          projectId: z.string().uuid(),
          goal: z.string().trim().max(4000).optional(),
          worktreeName: z.string().trim().min(1).max(100).optional(),
          agentId: z.string().uuid().optional(),
          roleKey: z.string().trim().min(1).max(100).optional(),
        });
        const body = bodySchema.parse(request.body ?? {});

        const actor = (request as any).user as { userId?: string; username?: string } | undefined;
        const createdBy = typeof actor?.username === "string" && actor.username.trim() ? actor.username.trim() : null;
        const createdByUserId = typeof actor?.userId === "string" && actor.userId.trim() ? actor.userId.trim() : null;

        const project = await deps.prisma.project.findUnique({ where: { id: body.projectId } });
        if (!project) {
          return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
        }
        if (!deps.sendToAgent) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
        }
        if (!deps.acp) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" } };
        }
        if (!deps.createWorkspace) {
          return { success: false, error: { code: "NO_WORKSPACE", message: "Workspace 创建器未配置" } };
        }

        const now = new Date();
        const name = body.worktreeName?.trim() ?? "";
        const goal = body.goal?.trim() ?? "";
        const goalLine = goal ? (goal.split(/\r?\n/)[0] ?? "").trim() : "";
        const titleBase = name ? `Session · ${name}` : goalLine ? `Session · ${goalLine}` : `Session · ${now.toISOString()}`;
        const title = titleBase.length > 255 ? titleBase.slice(0, 255) : titleBase;

        const issue = await deps.prisma.issue.create({
          data: {
            id: uuidv7(),
            projectId: project.id,
            title,
            description: goal || null,
            status: "pending",
            createdBy,
            labels: ["_session"],
            assignedAgentId: body.agentId ?? null,
          } as any,
        });

        try {
          const task = await createTaskFromTemplate({ prisma: deps.prisma }, issue.id, { templateKey: "quick.admin.session" });
          if (createdByUserId) {
            await deps.prisma.task
              .update({ where: { id: (task as any).id }, data: { createdByUserId } as any })
              .catch(() => {});
          }

          const stepId = (task as any).currentStepId ?? (task as any).steps?.[0]?.id ?? null;
          if (!stepId) {
            return { success: false, error: { code: "BAD_TASK", message: "Task 缺少可启动的 Step" } };
          }

          const started = await startStep({ prisma: deps.prisma }, stepId, { roleKey: body.roleKey } as any);

          const dispatched = await dispatchExecutionForRun(
            {
              prisma: deps.prisma,
              sendToAgent: deps.sendToAgent,
              acp: deps.acp,
              createWorkspace: deps.createWorkspace,
              broadcastToClients: deps.broadcastToClients,
              sandboxGitPush: deps.sandboxGitPush,
            },
            (started as any).run.id,
          );
          if (!dispatched.success) {
            return {
              success: false,
              error: { code: "DISPATCH_FAILED", message: "启动 Session 失败", details: dispatched.error },
              data: { issueId: issue.id, taskId: (started as any).task.id, stepId: (started as any).step.id, runId: (started as any).run.id },
            };
          }

          deps.broadcastToClients?.({ type: "task_created", issue_id: issue.id, task_id: (started as any).task.id, run_id: (started as any).run.id });

          return {
            success: true,
            data: {
              issueId: issue.id,
              taskId: (started as any).task.id,
              stepId: (started as any).step.id,
              runId: (started as any).run.id,
            },
          };
        } catch (err) {
          if (err instanceof TaskEngineError) {
            return { success: false, error: { code: err.code, message: err.message, details: err.details } };
          }
          return { success: false, error: { code: "UNKNOWN", message: "启动 Session 失败", details: String(err) } };
        }
      },
    );

    server.post(
      "/acp-sessions/cancel",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          runId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
        });
        const { runId, sessionId } = bodySchema.parse(request.body ?? {});

        const run = await deps.prisma.run.findUnique({
          where: { id: runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (!deps.sendToAgent) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
        }
        if (!deps.acp) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" } };
        }
        if (!(run as any).agent) {
          return { success: false, error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法关闭 session" } };
        }

        const cwd = resolveAgentWorkspaceCwd({
          runId,
          sandboxWorkspaceMode: getSandboxWorkspaceMode((run as any).agent?.capabilities),
        });
        try {
          await deps.acp.cancelSession({ proxyId: (run as any).agent.proxyId, runId, cwd, sessionId });

          await deps.prisma.run
            .update({
              where: { id: runId },
              data: {
                metadata: upsertAcpSessionStateInRunMetadata({
                  runMetadata: (run as any).metadata,
                  sessionId,
                  patch: {
                    activity: "cancel_requested",
                    inFlight: 0,
                    updatedAt: new Date().toISOString(),
                    note: "cancel_requested_by_admin",
                  },
                }) as any,
              } as any,
            })
            .catch(() => {});
        } catch (error) {
          return {
            success: false,
            error: {
              code: "AGENT_SEND_FAILED",
              message: "发送 session/cancel 失败",
              details: String(error),
            },
          };
        }

        return { success: true, data: { ok: true } };
      },
    );

    server.post(
      "/acp-sessions/force-close",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          runId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
        });
        const { runId, sessionId } = bodySchema.parse(request.body ?? {});

        const run = await deps.prisma.run.findUnique({
          where: { id: runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (typeof (run as any).acpSessionId === "string" && (run as any).acpSessionId !== sessionId) {
          return {
            success: false,
            error: {
              code: "BAD_REQUEST",
              message: "sessionId 不匹配当前 Run.acpSessionId（可能已经变更）",
              details: `run.acpSessionId=${String((run as any).acpSessionId)}`,
            },
          };
        }

        // best-effort cancel（可用则尝试；不可用也允许强制清理 DB）
        try {
          if (deps.acp && (run as any).agent) {
            const cwd =
              typeof (run as any).workspacePath === "string" && (run as any).workspacePath.trim()
                ? String((run as any).workspacePath)
                : "/workspace";
            await deps.acp.cancelSession({
              proxyId: (run as any).agent.proxyId,
              runId,
              cwd,
              sessionId,
            });
          }
        } catch {
          // ignore
        }

        await deps.prisma.run.update({
          where: { id: runId },
          data: {
            acpSessionId: null,
            metadata: upsertAcpSessionStateInRunMetadata({
              runMetadata: (run as any).metadata,
              sessionId,
              patch: {
                activity: "closed",
                inFlight: 0,
                updatedAt: new Date().toISOString(),
                note: "force_closed_by_admin",
              },
            }) as any,
          } as any,
        } as any);

        return { success: true, data: { ok: true } };
      },
    );

    server.post(
      "/acp-sessions/set-mode",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          runId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
          modeId: z.string().min(1).max(200),
        });
        const { runId, sessionId, modeId } = bodySchema.parse(request.body ?? {});

        const run = await deps.prisma.run.findUnique({
          where: { id: runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (!deps.sendToAgent) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
        }
        if (!deps.acp) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" } };
        }
        if (!(run as any).agent) {
          return { success: false, error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法设置 mode" } };
        }

        const cwd = resolveAgentWorkspaceCwd({
          runId,
          sandboxWorkspaceMode: getSandboxWorkspaceMode((run as any).agent?.capabilities),
        });
        try {
          await deps.acp.setSessionMode({ proxyId: (run as any).agent.proxyId, runId, cwd, sessionId, modeId });
        } catch (error) {
          return {
            success: false,
            error: {
              code: "AGENT_SEND_FAILED",
              message: "发送 session/set_mode 失败",
              details: String(error),
            },
          };
        }

        return { success: true, data: { ok: true } };
      },
    );

    server.post(
      "/acp-sessions/set-model",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          runId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
          modelId: z.string().min(1).max(200),
        });
        const { runId, sessionId, modelId } = bodySchema.parse(request.body ?? {});

        const run = await deps.prisma.run.findUnique({
          where: { id: runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (!deps.sendToAgent) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
        }
        if (!deps.acp) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" } };
        }
        if (!(run as any).agent) {
          return { success: false, error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法设置 model" } };
        }

        const cwd = resolveAgentWorkspaceCwd({
          runId,
          sandboxWorkspaceMode: getSandboxWorkspaceMode((run as any).agent?.capabilities),
        });
        try {
          await deps.acp.setSessionModel({ proxyId: (run as any).agent.proxyId, runId, cwd, sessionId, modelId });
        } catch (error) {
          return {
            success: false,
            error: {
              code: "AGENT_SEND_FAILED",
              message: "发送 session/set_model 失败",
              details: String(error),
            },
          };
        }

        return { success: true, data: { ok: true } };
      },
    );

    server.post(
      "/acp-sessions/permission",
      { preHandler: requireAdmin },
      async (request) => {
        const bodySchema = z.object({
          runId: z.string().uuid(),
          sessionId: z.string().min(1).max(200),
          requestId: z.union([z.string().min(1), z.number().int()]),
          outcome: z.enum(["selected", "cancelled"]),
          optionId: z.string().min(1).max(200).optional(),
        });
        const { runId, sessionId, requestId, outcome, optionId } = bodySchema.parse(
          request.body ?? {},
        );

        if (outcome === "selected" && !optionId) {
          return {
            success: false,
            error: { code: "OPTION_REQUIRED", message: "outcome=selected 时必须提供 optionId" },
          };
        }

        const run = await deps.prisma.run.findUnique({
          where: { id: runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (!deps.sendToAgent) {
          return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
        }
        if (!(run as any).agent) {
          return { success: false, error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent" } };
        }

        try {
          await deps.sendToAgent((run as any).agent.proxyId, {
            type: "session_permission",
            run_id: runId,
            session_id: sessionId,
            request_id: requestId,
            outcome,
            option_id: outcome === "selected" ? optionId : null,
          });
        } catch (error) {
          return {
            success: false,
            error: {
              code: "AGENT_SEND_FAILED",
              message: "发送 session_permission 失败",
              details: String(error),
            },
          };
        }

        return { success: true, data: { ok: true } };
      },
    );
  };
}
