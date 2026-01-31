import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";

type VersionPolicy = "latest" | "pinned";

function normalizePolicy(raw: unknown): VersionPolicy {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "pinned") return "pinned";
  return "latest";
}

export function makeRoleSkillBindingRoutes(deps: { prisma: PrismaDeps; auth: AuthHelpers }): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get(
      "/projects/:projectId/roles/:roleId/skills",
      { preHandler: requireAdmin },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
        const { projectId, roleId } = paramsSchema.parse(request.params);

        const role = await deps.prisma.roleTemplate.findFirst({
          where: { id: roleId, projectId },
          select: { id: true },
        });
        if (!role) {
          return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
        }

        const bindings = await deps.prisma.roleSkillBinding.findMany({
          where: { roleTemplateId: roleId },
          orderBy: { createdAt: "asc" },
          include: { skill: { select: { id: true, name: true } } },
        });

        return {
          success: true,
          data: {
            projectId,
            roleId,
            items: (bindings as any[]).map((b) => ({
              skillId: String(b.skillId ?? ""),
              name: String(b.skill?.name ?? ""),
              versionPolicy: String(b.versionPolicy ?? "latest"),
              pinnedVersionId: b.pinnedVersionId ?? null,
              enabled: b.enabled === true,
            })),
          },
        };
      },
    );

    server.put(
      "/projects/:projectId/roles/:roleId/skills",
      { preHandler: requireAdmin },
      async (request) => {
        const paramsSchema = z.object({ projectId: z.string().uuid(), roleId: z.string().uuid() });
        const bodySchema = z.object({
          items: z
            .array(
              z.object({
                skillId: z.string().uuid(),
                versionPolicy: z.string().optional(),
                pinnedVersionId: z.string().uuid().optional(),
                enabled: z.boolean().optional(),
              }),
            )
            .max(500)
            .default([]),
        });

        const { projectId, roleId } = paramsSchema.parse(request.params);
        const body = bodySchema.parse(request.body ?? {});

        const role = await deps.prisma.roleTemplate.findFirst({
          where: { id: roleId, projectId },
          select: { id: true },
        });
        if (!role) {
          return { success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } };
        }

        const normalized = body.items.map((it) => ({
          skillId: it.skillId,
          versionPolicy: normalizePolicy(it.versionPolicy),
          pinnedVersionId: it.pinnedVersionId,
          enabled: it.enabled !== false,
        }));

        const seen = new Set<string>();
        for (const it of normalized) {
          if (seen.has(it.skillId)) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: `重复的 skillId: ${it.skillId}` },
            };
          }
          seen.add(it.skillId);
        }

        const skillIds = normalized.map((it) => it.skillId);
        if (skillIds.length) {
          const found = await deps.prisma.skill.findMany({
            where: { id: { in: skillIds } },
            select: { id: true },
          });
          const foundSet = new Set((found as any[]).map((s) => String((s as any).id ?? "")));
          const missing = skillIds.filter((id) => !foundSet.has(id));
          if (missing.length) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: `skillId 不存在: ${missing.join(", ")}` },
            };
          }
        }

        const pinnedVersionIds = normalized
          .filter((it) => it.versionPolicy === "pinned")
          .map((it) => it.pinnedVersionId)
          .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

        if (normalized.some((it) => it.versionPolicy === "pinned" && !it.pinnedVersionId)) {
          return {
            success: false,
            error: { code: "BAD_INPUT", message: "versionPolicy=pinned 时必须提供 pinnedVersionId" },
          };
        }

        if (pinnedVersionIds.length) {
          const versions = await deps.prisma.skillVersion.findMany({
            where: { id: { in: pinnedVersionIds } },
            select: { id: true, skillId: true },
          });
          const byId = new Map<string, string>();
          for (const v of versions as any[]) byId.set(String(v.id ?? ""), String(v.skillId ?? ""));

          const missing = pinnedVersionIds.filter((id) => !byId.has(id));
          if (missing.length) {
            return {
              success: false,
              error: { code: "BAD_INPUT", message: `pinnedVersionId 不存在: ${missing.join(", ")}` },
            };
          }

          for (const it of normalized) {
            if (it.versionPolicy !== "pinned") continue;
            const pinnedId = String(it.pinnedVersionId ?? "");
            const ownerSkillId = byId.get(pinnedId) ?? "";
            if (ownerSkillId && ownerSkillId !== it.skillId) {
              return {
                success: false,
                error: {
                  code: "BAD_INPUT",
                  message: `pinnedVersionId 不属于该 skill（skillId=${it.skillId}, pinnedVersionId=${pinnedId}）`,
                },
              };
            }
          }
        }

        await deps.prisma.$transaction(async (tx: any) => {
          await tx.roleSkillBinding.deleteMany({ where: { roleTemplateId: roleId } });
          if (!normalized.length) return;
          await tx.roleSkillBinding.createMany({
            data: normalized.map((it) => ({
              roleTemplateId: roleId,
              skillId: it.skillId,
              versionPolicy: it.versionPolicy,
              pinnedVersionId: it.versionPolicy === "pinned" ? it.pinnedVersionId : null,
              enabled: it.enabled,
            })),
          });
        });

        const bindings = await deps.prisma.roleSkillBinding.findMany({
          where: { roleTemplateId: roleId },
          orderBy: { createdAt: "asc" },
          include: { skill: { select: { id: true, name: true } } },
        });

        return {
          success: true,
          data: {
            projectId,
            roleId,
            items: (bindings as any[]).map((b) => ({
              skillId: String(b.skillId ?? ""),
              name: String(b.skill?.name ?? ""),
              versionPolicy: String(b.versionPolicy ?? "latest"),
              pinnedVersionId: b.pinnedVersionId ?? null,
              enabled: b.enabled === true,
            })),
          },
        };
      },
    );
  };
}

