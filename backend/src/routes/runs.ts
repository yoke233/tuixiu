import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";

export function makeRunRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.findUnique({
        where: { id },
        include: { issue: true, agent: true, artifacts: true }
      });
      if (!run) {
        return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
      }
      return { success: true, data: { run } };
    });

    server.get("/:id/events", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const querySchema = z.object({
        limit: z.coerce.number().int().positive().max(500).default(200)
      });
      const { id } = paramsSchema.parse(request.params);
      const { limit } = querySchema.parse(request.query);

      const events = await deps.prisma.event.findMany({
        where: { runId: id },
        orderBy: { timestamp: "desc" },
        take: limit
      });
      return { success: true, data: { events } };
    });

    server.post("/:id/cancel", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const run = await deps.prisma.run.update({
        where: { id },
        data: { status: "cancelled", completedAt: new Date() }
      });

      return { success: true, data: { run } };
    });
  };
}
