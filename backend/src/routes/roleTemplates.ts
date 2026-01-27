import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";

export function makeRoleTemplateRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/:projectId/roles", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const { projectId } = paramsSchema.parse(request.params);

      const roles = await deps.prisma.roleTemplate.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
      });

      return { success: true, data: { roles } };
    });

    server.post("/:projectId/roles", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid() });
      const bodySchema = z.object({
        key: z.string().min(1).max(100),
        displayName: z.string().min(1).max(255),
        description: z.string().optional(),
        promptTemplate: z.string().optional(),
        initScript: z.string().optional(),
        initTimeoutSeconds: z.coerce.number().int().positive().max(3600).default(300),
      });

      const { projectId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const project = await deps.prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };
      }

      const role = await deps.prisma.roleTemplate.create({
        data: {
          id: uuidv7(),
          projectId,
          key: body.key,
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
        },
      });

      return { success: true, data: { role } };
    });

    server.patch("/:projectId/roles/:roleId", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
      const bodySchema = z.object({
        displayName: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        promptTemplate: z.string().optional(),
        initScript: z.string().optional(),
        initTimeoutSeconds: z.coerce.number().int().positive().max(3600).optional(),
      });

      const { projectId, roleId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const existing = await deps.prisma.roleTemplate.findFirst({ where: { id: roleId, projectId } });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
      }

      const role = await deps.prisma.roleTemplate.update({
        where: { id: roleId },
        data: {
          displayName: body.displayName,
          description: body.description,
          promptTemplate: body.promptTemplate,
          initScript: body.initScript,
          initTimeoutSeconds: body.initTimeoutSeconds,
        },
      });

      return { success: true, data: { role } };
    });

    server.delete("/:projectId/roles/:roleId", async (request) => {
      const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
      const { projectId, roleId } = paramsSchema.parse(request.params);

      const existing = await deps.prisma.roleTemplate.findFirst({ where: { id: roleId, projectId } });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
      }

      await deps.prisma.roleTemplate.delete({ where: { id: roleId } });

      return { success: true, data: { roleId } };
    });
  };
}

