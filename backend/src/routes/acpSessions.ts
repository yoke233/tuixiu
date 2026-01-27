import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps, SendToAgent } from "../deps.js";

export function makeAcpSessionRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
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
        if (!(run as any).agent) {
          return { success: false, error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法关闭 session" } };
        }

        try {
          await deps.sendToAgent((run as any).agent.proxyId, {
            type: "session_cancel",
            run_id: runId,
            session_id: sessionId,
          });
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
  };
}

