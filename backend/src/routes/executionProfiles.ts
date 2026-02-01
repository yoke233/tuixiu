import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";

const workspacePolicySchema = z.enum(["git", "mount", "empty", "bundle"]);

export function makeExecutionProfileRoutes(deps: { prisma: PrismaDeps }): FastifyPluginAsync {
  return async (server) => {
    server.get("/execution-profiles", async () => {
      const profiles = await deps.prisma.executionProfile.findMany({
        orderBy: { createdAt: "desc" },
      });
      return { success: true, data: { profiles } };
    });

    server.get("/execution-profiles/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);
      const profile = await deps.prisma.executionProfile.findUnique({ where: { id } });
      if (!profile) {
        return { success: false, error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" } };
      }
      return { success: true, data: { profile } };
    });

    server.post("/execution-profiles", async (request) => {
      const bodySchema = z.object({
        key: z.string().min(1).max(100),
        displayName: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        workspacePolicy: workspacePolicySchema.optional(),
        skillsPolicy: z.string().optional(),
        toolPolicy: z.unknown().optional(),
        dataPolicy: z.unknown().optional(),
      });
      const body = bodySchema.parse(request.body ?? {});
      const actor = (request as any)?.user ?? {};

      const profile = await deps.prisma.executionProfile.create({
        data: {
          id: uuidv7(),
          key: body.key,
          displayName: body.displayName,
          description: body.description,
          workspacePolicy: body.workspacePolicy ?? null,
          skillsPolicy: body.skillsPolicy ?? null,
          toolPolicy: body.toolPolicy ?? null,
          dataPolicy: body.dataPolicy ?? null,
          createdByUserId: actor?.id ?? null,
          updatedByUserId: actor?.id ?? null,
        } as any,
      });

      await deps.prisma.executionProfileAuditLog
        .create({
          data: {
            id: uuidv7(),
            executionProfileId: profile.id,
            action: "create",
            actorUserId: actor?.id ?? null,
            payload: { key: profile.key },
          } as any,
        })
        .catch(() => {});

      return { success: true, data: { profile } };
    });

    server.patch("/execution-profiles/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        displayName: z.string().min(1).max(255).nullable().optional(),
        description: z.string().nullable().optional(),
        workspacePolicy: workspacePolicySchema.nullable().optional(),
        skillsPolicy: z.string().nullable().optional(),
        toolPolicy: z.unknown().nullable().optional(),
        dataPolicy: z.unknown().nullable().optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});
      const actor = (request as any)?.user ?? {};

      const existing = await deps.prisma.executionProfile.findUnique({ where: { id } });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" } };
      }

      const profile = await deps.prisma.executionProfile.update({
        where: { id },
        data: {
          displayName: body.displayName,
          description: body.description,
          workspacePolicy: body.workspacePolicy,
          skillsPolicy: body.skillsPolicy,
          toolPolicy: body.toolPolicy,
          dataPolicy: body.dataPolicy,
          updatedByUserId: actor?.id ?? null,
        } as any,
      });

      await deps.prisma.executionProfileAuditLog
        .create({
          data: {
            id: uuidv7(),
            executionProfileId: profile.id,
            action: "update",
            actorUserId: actor?.id ?? null,
            payload: { changes: body },
          } as any,
        })
        .catch(() => {});

      return { success: true, data: { profile } };
    });

    server.delete("/execution-profiles/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);
      const actor = (request as any)?.user ?? {};

      const existing = await deps.prisma.executionProfile.findUnique({ where: { id } });
      if (!existing) {
        return { success: false, error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" } };
      }

      await deps.prisma.executionProfile.delete({ where: { id } });

      await deps.prisma.executionProfileAuditLog
        .create({
          data: {
            id: uuidv7(),
            executionProfileId: id,
            action: "delete",
            actorUserId: actor?.id ?? null,
            payload: { key: existing.key },
          } as any,
        })
        .catch(() => {});

      return { success: true, data: { id } };
    });
  };
}
