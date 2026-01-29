import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import Handlebars from "handlebars";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import {
  listPlatformTextTemplates,
  listProjectTextTemplates,
  patchPlatformTextTemplates,
  patchProjectTextTemplates,
} from "../modules/templates/textTemplates.js";
import { normalizeTemplateText } from "../utils/textTemplate.js";

export function makeTextTemplateRoutes(deps: { prisma: PrismaDeps; auth: AuthHelpers }): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get("/text-templates", { preHandler: requireAdmin }, async () => {
      const templates = await listPlatformTextTemplates({ prisma: deps.prisma });
      return { success: true, data: { templates } };
    });

    server.patch("/text-templates", { preHandler: requireAdmin }, async (request) => {
      const bodySchema = z.object({
        templates: z.record(z.string().min(1).max(200), z.string().max(200_000).nullable()),
      });
      const body = bodySchema.parse(request.body ?? {});

      for (const [key, value] of Object.entries(body.templates)) {
        if (value === null) continue;
        const normalized = normalizeTemplateText(value);
        if (!normalized) continue;
        try {
          Handlebars.parse(normalized);
        } catch (err) {
          return {
            success: false,
            error: { code: "BAD_TEMPLATE", message: `模板编译失败: ${key}`, details: String(err) },
          };
        }
      }

      await patchPlatformTextTemplates({ prisma: deps.prisma }, body.templates);

      const templates = await listPlatformTextTemplates({ prisma: deps.prisma });
      return { success: true, data: { templates } };
    });

    server.get("/projects/:projectId/text-templates", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const exists = await deps.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!exists) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

      const platform = await listPlatformTextTemplates({ prisma: deps.prisma });
      const overrides = await listProjectTextTemplates({ prisma: deps.prisma }, projectId);
      const effective = { ...platform, ...overrides };

      return { success: true, data: { projectId, platform, overrides, effective } };
    });

    server.patch("/projects/:projectId/text-templates", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const bodySchema = z.object({
        templates: z.record(z.string().min(1).max(200), z.string().max(200_000).nullable()),
      });
      const { projectId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const exists = await deps.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
      if (!exists) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

      for (const [key, value] of Object.entries(body.templates)) {
        if (value === null) continue;
        const normalized = normalizeTemplateText(value);
        if (!normalized) continue;
        try {
          Handlebars.parse(normalized);
        } catch (err) {
          return {
            success: false,
            error: { code: "BAD_TEMPLATE", message: `模板编译失败: ${key}`, details: String(err) },
          };
        }
      }

      await patchProjectTextTemplates({ prisma: deps.prisma }, { projectId, patch: body.templates });

      const platform = await listPlatformTextTemplates({ prisma: deps.prisma });
      const overrides = await listProjectTextTemplates({ prisma: deps.prisma }, projectId);
      const effective = { ...platform, ...overrides };

      return { success: true, data: { projectId, platform, overrides, effective } };
    });
  };
}
