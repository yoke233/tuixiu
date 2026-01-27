import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps, SendToAgent } from "../deps.js";
import type { AcpTunnel } from "../services/acpTunnel.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function makeAcpSessionRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  acp?: AcpTunnel;
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

        const where: Record<string, unknown> = {
          executorType: "agent",
          acpSessionId: { not: null },
        };
        if (projectId) {
          where.issue = { projectId };
        }

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
        const cwd = String((run as any).workspacePath ?? "").trim();
        if (!cwd) {
          return { success: false, error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法关闭 session" } };
        }

        try {
          await deps.acp.cancelSession({ proxyId: (run as any).agent.proxyId, runId, cwd, sessionId });
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
        const cwd = String((run as any).workspacePath ?? "").trim();
        if (!cwd) {
          return { success: false, error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法设置 mode" } };
        }

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
        const cwd = String((run as any).workspacePath ?? "").trim();
        if (!cwd) {
          return { success: false, error: { code: "NO_WORKSPACE", message: "Run.workspacePath 缺失，无法设置 model" } };
        }

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
  };
}
