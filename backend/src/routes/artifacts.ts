import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { publishArtifact } from "../services/artifactPublish.js";

export function makeArtifactRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.post("/artifacts/:id/publish", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ path: z.string().min(1).max(300).optional() });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      return await publishArtifact({ prisma: deps.prisma }, id, body);
    });
  };
}

