import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";

function isNonEmptyString(value: unknown): boolean {
  return !!String(value ?? "").trim();
}

function toScmConfigDto(projectId: string, config: any | null) {
  return {
    projectId,
    gitlabProjectId: config?.gitlabProjectId ?? null,
    hasGitlabWebhookSecret: isNonEmptyString(config?.gitlabWebhookSecret),
    githubPollingEnabled: config?.githubPollingEnabled ?? false,
    githubPollingCursor: config?.githubPollingCursor ?? null,
  };
}

export function makeProjectScmConfigRoutes(deps: { prisma: PrismaDeps; auth: AuthHelpers }): FastifyPluginAsync {
  return async (server) => {
    server.get("/:projectId/scm-config", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }

      const config = await deps.prisma.projectScmConfig.findUnique({ where: { projectId } });

      return { success: true, data: { scmConfig: toScmConfigDto(projectId, config as any) } };
    });

    server.put(
      "/:projectId/scm-config",
      { preHandler: deps.auth.requireRoles(["admin"]) },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid() });
        const bodySchema = z.object({
          gitlabProjectId: z.coerce.number().int().positive().nullable().optional(),
          gitlabWebhookSecret: z.string().min(1).nullable().optional(),
          githubPollingEnabled: z.boolean().optional(),
        });

        const { projectId } = paramsSchema.parse(request.params);
        const body = bodySchema.parse(request.body ?? {});

        const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
        if (!project) {
          return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
        }

        const update: Record<string, unknown> = {};
        if (body.gitlabProjectId !== undefined) update.gitlabProjectId = body.gitlabProjectId;
        if (body.gitlabWebhookSecret !== undefined) update.gitlabWebhookSecret = body.gitlabWebhookSecret;
        if (body.githubPollingEnabled !== undefined) update.githubPollingEnabled = body.githubPollingEnabled;

        const config = await deps.prisma.projectScmConfig.upsert({
          where: { projectId },
          create: {
            id: uuidv7(),
            projectId,
            gitlabProjectId: body.gitlabProjectId ?? null,
            gitlabWebhookSecret: body.gitlabWebhookSecret ?? null,
            githubPollingEnabled: body.githubPollingEnabled ?? false,
          } as any,
          update: update as any,
        });

        return { success: true, data: { scmConfig: toScmConfigDto(projectId, config as any) } };
      },
    );
  };
}

