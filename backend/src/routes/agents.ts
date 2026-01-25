import type { FastifyPluginAsync } from "fastify";

import type { PrismaDeps } from "../deps.js";

export function makeAgentRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async () => {
      const agents = await deps.prisma.agent.findMany({
        orderBy: { createdAt: "desc" }
      });
      return { success: true, data: { agents } };
    });
  };
}
