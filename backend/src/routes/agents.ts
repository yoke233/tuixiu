import type { FastifyPluginAsync } from "fastify";

import type { PrismaDeps } from "../db.js";

export function makeAgentRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async () => {
      const agents = await deps.prisma.agent.findMany({
        orderBy: { createdAt: "desc" }
      });

      // 基于 lastHeartbeat 做一次轻量的“失活”判定，避免 DB 状态长期停留在 online。
      const now = Date.now();
      const staleIds: string[] = [];
      const normalized = agents.map((a: any) => {
        if (!a || typeof a !== "object") return a;
        if (a.status !== "online") return a;

        const hb = a.lastHeartbeat instanceof Date ? a.lastHeartbeat : new Date(String(a.lastHeartbeat ?? ""));
        const hbMs = Number.isFinite(hb.getTime()) ? hb.getTime() : NaN;
        if (!Number.isFinite(hbMs)) return a;

        const intervalRaw = typeof a.healthCheckInterval === "number" ? a.healthCheckInterval : 30;
        const intervalSeconds = Number.isFinite(intervalRaw) ? Math.max(5, Math.trunc(intervalRaw)) : 30;
        const staleAfterMs = Math.max(90_000, intervalSeconds * 3 * 1000);

        if (now - hbMs <= staleAfterMs) return a;
        if (typeof a.id === "string" && a.id) staleIds.push(a.id);
        return { ...a, status: "offline" };
      });

      if (staleIds.length) {
        await deps.prisma.agent.updateMany({ where: { id: { in: staleIds } }, data: { status: "offline" } }).catch(() => {});
      }

      return { success: true, data: { agents: normalized } };
    });
  };
}
