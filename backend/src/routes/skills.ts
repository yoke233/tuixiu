import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";

function parseTagsCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return Array.from(new Set(parts));
}

function clampLimit(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 50;
  return Math.max(1, Math.min(200, Math.floor(v)));
}

function toLatestVersionDto(v: any): { versionId: string; contentHash: string; importedAt: string } | null {
  if (!v) return null;
  const versionId = typeof v.id === "string" ? v.id : "";
  const contentHash = typeof v.contentHash === "string" ? v.contentHash : "";
  const importedAt =
    v.importedAt instanceof Date ? v.importedAt.toISOString() : String(v.importedAt ?? "").trim();
  if (!versionId || !contentHash || !importedAt) return null;
  return { versionId, contentHash, importedAt };
}

export function makeSkillRoutes(deps: { prisma: PrismaDeps; auth: AuthHelpers }): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get("/skills/search", { preHandler: requireAdmin }, async (request) => {
      const querySchema = z.object({
        provider: z.string().optional(),
        q: z.string().optional(),
        tags: z.string().optional(),
        limit: z.coerce.number().int().positive().optional(),
        cursor: z.string().optional(),
      });
      const query = querySchema.parse(request.query ?? {});

      const provider = String(query.provider ?? "")
        .trim()
        .toLowerCase();
      const effectiveProvider = provider || "registry";
      if (effectiveProvider !== "registry") {
        return {
          success: false,
          error: { code: "BAD_INPUT", message: `不支持的 provider: ${effectiveProvider}` },
        };
      }

      const q = typeof query.q === "string" ? query.q.trim() : "";
      const tags = parseTagsCsv(query.tags);
      const limit = clampLimit(query.limit);

      const and: any[] = [];
      if (q) {
        const qLower = q.toLowerCase();
        and.push({
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
            { tags: { has: qLower } },
          ],
        });
      }
      if (tags.length) {
        and.push({ tags: { hasSome: tags } });
      }
      const where = and.length ? { AND: and } : undefined;

      const skills = await deps.prisma.skill.findMany({
        where,
        orderBy: q ? { updatedAt: "desc" } : { name: "asc" },
        take: limit,
        include: {
          versions: {
            orderBy: { importedAt: "desc" },
            take: 1,
            select: { id: true, contentHash: true, importedAt: true },
          },
        },
      });

      const items = (skills as any[]).map((s) => {
        const latest = Array.isArray((s as any).versions) ? (s as any).versions[0] : null;
        return {
          skillId: String((s as any).id ?? ""),
          name: String((s as any).name ?? ""),
          description: (s as any).description ?? null,
          tags: Array.isArray((s as any).tags) ? ((s as any).tags as unknown[]).map(String) : [],
          installed: true,
          latestVersion: toLatestVersionDto(latest),
        };
      });

      return {
        success: true,
        data: { provider: effectiveProvider, items, nextCursor: null },
      };
    });

    server.get("/skills/:skillId", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ skillId: z.string().uuid() });
      const { skillId } = paramsSchema.parse(request.params);

      const skill = await deps.prisma.skill.findUnique({ where: { id: skillId } });
      if (!skill) {
        return { success: false, error: { code: "NOT_FOUND", message: "Skill 不存在" } };
      }

      return {
        success: true,
        data: {
          skill: {
            id: skill.id,
            name: skill.name,
            description: skill.description ?? null,
            tags: Array.isArray((skill as any).tags) ? ((skill as any).tags as unknown[]).map(String) : [],
            createdAt: skill.createdAt,
            updatedAt: skill.updatedAt,
          },
        },
      };
    });

    server.get("/skills/:skillId/versions", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ skillId: z.string().uuid() });
      const { skillId } = paramsSchema.parse(request.params);

      const exists = await deps.prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } });
      if (!exists) {
        return { success: false, error: { code: "NOT_FOUND", message: "Skill 不存在" } };
      }

      const versions = await deps.prisma.skillVersion.findMany({
        where: { skillId },
        orderBy: { importedAt: "desc" },
      });

      return {
        success: true,
        data: {
          skillId,
          versions: (versions as any[]).map((v) => ({
            id: String(v.id ?? ""),
            contentHash: String(v.contentHash ?? ""),
            storageUri: typeof (v as any).storageUri === "string" ? String((v as any).storageUri) : null,
            source: (v as any).source ?? null,
            importedAt: v.importedAt,
          })),
        },
      };
    });
  };
}

