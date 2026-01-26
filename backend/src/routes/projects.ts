import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";

const createProjectBodySchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().min(1),
  scmType: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  defaultRoleKey: z.string().min(1).max(100).optional(),
  gitlabProjectId: z.coerce.number().int().positive().optional(),
  gitlabAccessToken: z.string().min(1).optional(),
  gitlabWebhookSecret: z.string().min(1).optional(),
  githubAccessToken: z.string().min(1).optional()
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
          defaultRoleKey: body.defaultRoleKey,
          gitlabProjectId: body.gitlabProjectId,
          gitlabAccessToken: body.gitlabAccessToken,
          gitlabWebhookSecret: body.gitlabWebhookSecret,
          githubAccessToken: body.githubAccessToken
        }
      });
      return { success: true, data: { project } };
    });

    server.patch("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        name: z.string().min(1).optional(),
        repoUrl: z.string().min(1).optional(),
        scmType: z.string().min(1).optional(),
        defaultBranch: z.string().min(1).optional(),
        defaultRoleKey: z.string().min(1).max(100).nullable().optional(),
        gitlabProjectId: z.coerce.number().int().positive().nullable().optional(),
        gitlabAccessToken: z.string().min(1).nullable().optional(),
        gitlabWebhookSecret: z.string().min(1).nullable().optional(),
        githubAccessToken: z.string().min(1).nullable().optional()
      });

      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const exists = await deps.prisma.project.findUnique({ where: { id } });
      if (!exists) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }

      const data: Record<string, unknown> = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.repoUrl !== undefined) data.repoUrl = body.repoUrl;
      if (body.scmType !== undefined) data.scmType = body.scmType;
      if (body.defaultBranch !== undefined) data.defaultBranch = body.defaultBranch;
      if (body.defaultRoleKey !== undefined) data.defaultRoleKey = body.defaultRoleKey;
      if (body.gitlabProjectId !== undefined) data.gitlabProjectId = body.gitlabProjectId;
      if (body.gitlabAccessToken !== undefined) data.gitlabAccessToken = body.gitlabAccessToken;
      if (body.gitlabWebhookSecret !== undefined) data.gitlabWebhookSecret = body.gitlabWebhookSecret;
      if (body.githubAccessToken !== undefined) data.githubAccessToken = body.githubAccessToken;

      const project = await deps.prisma.project.update({
        where: { id },
        data: data as any
      });

      return { success: true, data: { project } };
    });
  };
}
