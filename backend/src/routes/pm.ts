import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import type { PmAutomation } from "../services/pm/pmAutomation.js";
import { autoReviewRunForPm } from "../services/pm/pmAutoReviewRun.js";

export function makePmRoutes(deps: { prisma: PrismaDeps; pm: PmAutomation }): FastifyPluginAsync {
  return async (server) => {
    server.post("/issues/:id/analyze", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const res = await deps.pm.analyze(id);
      if (!res.ok) {
        return { success: false, error: res.error };
      }
      return { success: true, data: { analysis: res.analysis, meta: res.meta } };
    });

    server.post("/issues/:id/dispatch", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ reason: z.string().min(1).max(200).default("manual") });
      const { id } = paramsSchema.parse(request.params);
      const { reason } = bodySchema.parse(request.body ?? {});

      const res = await deps.pm.dispatch(id, reason);
      return res as any;
    });

    server.post("/runs/:id/auto-review", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);
      return await autoReviewRunForPm({ prisma: deps.prisma }, id);
    });
  };
}
