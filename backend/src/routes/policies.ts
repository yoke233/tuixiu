import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { getPmPolicyForProject, setPmPolicyForProject, pmPolicyV1Schema } from "../services/pm/pmPolicy.js";

export function makePolicyRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/policies", async (request) => {
      const querySchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = querySchema.parse(request.query);
      return await getPmPolicyForProject({ prisma: deps.prisma }, projectId);
    });

    server.put("/policies", async (request) => {
      const querySchema = z.object({ projectId: z.string().uuid() });
      const bodySchema = z.object({ policy: pmPolicyV1Schema });
      const { projectId } = querySchema.parse(request.query);
      const { policy } = bodySchema.parse(request.body ?? {});

      return await setPmPolicyForProject({ prisma: deps.prisma }, { projectId, policy });
    });
  };
}

