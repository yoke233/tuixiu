import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";

const createProjectBodySchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  scmType: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  gitlabProjectId: z.coerce.number().int().positive().optional(),
  gitlabAccessToken: z.string().min(1).optional(),
  gitlabWebhookSecret: z.string().min(1).optional()
});

export function makeProjectRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async () => {
      const projects = await deps.prisma.project.findMany({ orderBy: { createdAt: "desc" } });
      return { success: true, data: { projects } };
    });

    server.post("/", async (request) => {
      const body = createProjectBodySchema.parse(request.body);
      const project = await deps.prisma.project.create({
        data: {
          id: uuidv7(),
          name: body.name,
          repoUrl: body.repoUrl,
          scmType: body.scmType ?? "gitlab",
          defaultBranch: body.defaultBranch ?? "main",
          gitlabProjectId: body.gitlabProjectId,
          gitlabAccessToken: body.gitlabAccessToken,
          gitlabWebhookSecret: body.gitlabWebhookSecret
        }
      });
      return { success: true, data: { project } };
    });
  };
}
