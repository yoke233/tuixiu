import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps } from "../db.js";
import type { SkillPackageStore } from "../modules/skills/skillPackageStore.js";
import type { SkillsCliRunner } from "../modules/skills/npxSkillsCli.js";
import { writeSkillAuditLog } from "../modules/skills/skillAudit.js";
import { parseSkillsShSourceKey } from "../modules/skills/skillsSh.js";
import { packageSkillsShPrepared, prepareSkillsShImport, type SkillsShImportMode } from "../modules/skills/skillsShImport.js";
import { uuidv7 } from "../utils/uuid.js";

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

function toExternalSkillId(sourceType: string, sourceKey: string): string {
  return `external:${sourceType}:${sourceKey}`;
}

async function resolveUniqueSkillName(prisma: PrismaDeps, baseName: string, sourceKey: string): Promise<string> {
  const normalized = baseName.trim().slice(0, 200) || "skill";
  const exists = await prisma.skill.findUnique({ where: { name: normalized }, select: { id: true } } as any).catch(() => null);
  if (!exists) return normalized;

  const suffix = sourceKey.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60);
  const candidate = `${normalized}-${suffix}`.slice(0, 200);
  const exists2 = await prisma.skill.findUnique({ where: { name: candidate }, select: { id: true } } as any).catch(() => null);
  if (!exists2) return candidate;

  return `${normalized}-${uuidv7().slice(-8)}`.slice(0, 200);
}

export function makeSkillRoutes(deps: {
  prisma: PrismaDeps;
  auth: AuthHelpers;
  skillsCli?: SkillsCliRunner;
  packages?: SkillPackageStore;
}): FastifyPluginAsync {
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

      const q = typeof query.q === "string" ? query.q.trim() : "";
      const tags = parseTagsCsv(query.tags);
      const limit = clampLimit(query.limit);

      if (effectiveProvider === "skills.sh") {
        if (!q) {
          return { success: true, data: { provider: effectiveProvider, items: [], nextCursor: null } };
        }

        const timeoutMs = Number(process.env.SKILLS_CLI_TIMEOUT_MS ?? "20000");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, timeoutMs));
        (timer as any).unref?.();

        const url = new URL("https://skills.sh/api/search");
        url.searchParams.set("q", q);
        url.searchParams.set("limit", String(Math.min(limit, 200)));

        let body: any;
        try {
          const res = await fetch(url.toString(), {
            method: "GET",
            headers: { accept: "application/json" },
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`SKILLS_SH_API_FAILED(status=${res.status}) ${text}`.trim());
          }
          body = await res.json();
        } finally {
          clearTimeout(timer);
        }

        const skills = Array.isArray(body?.skills) ? (body.skills as any[]) : [];
        const refsRaw = skills
          .map((s) => {
            const id = typeof s?.id === "string" ? s.id : "";
            const topSource = typeof s?.topSource === "string" ? s.topSource : "";
            const installsRaw = Number((s as any)?.installs ?? NaN);
            const installs = Number.isFinite(installsRaw) ? Math.max(0, Math.floor(installsRaw)) : null;
            if (!id || !topSource) return null;

            const ref = parseSkillsShSourceKey(`${topSource}@${id}`);
            if (!ref) return null;
            return { ref, installs };
          })
          .filter((x): x is { ref: NonNullable<ReturnType<typeof parseSkillsShSourceKey>>; installs: number | null } => !!x);

        const dedup = new Map<string, (typeof refsRaw)[number]>();
        for (const r of refsRaw) {
          if (!dedup.has(r.ref.sourceKey)) dedup.set(r.ref.sourceKey, r);
        }
        const picked = Array.from(dedup.values()).slice(0, limit);
        const sourceKeys = picked.map((x) => x.ref.sourceKey);

        const installed = sourceKeys.length
          ? await deps.prisma.skill.findMany({
                where: { sourceType: "skills.sh", sourceKey: { in: sourceKeys } } as any,
              select: {
                id: true,
                name: true,
                description: true,
                tags: true,
                sourceKey: true,
                latestVersion: { select: { id: true, contentHash: true, importedAt: true, sourceRevision: true } },
              } as any,
            })
          : [];

        const bySourceKey = new Map<string, any>();
        for (const s of installed as any[]) {
          const sk = typeof (s as any).sourceKey === "string" ? String((s as any).sourceKey) : "";
          if (sk) bySourceKey.set(sk, s);
        }

        const items = picked.map((ref) => {
          const skill = bySourceKey.get(ref.ref.sourceKey) ?? null;
          const latest = skill ? (skill as any).latestVersion : null;
          return {
            skillId: skill ? String((skill as any).id ?? "") : toExternalSkillId(ref.ref.sourceType, ref.ref.sourceKey),
            name: skill ? String((skill as any).name ?? "") : ref.ref.skill,
            description: skill ? ((skill as any).description ?? null) : null,
            tags: skill && Array.isArray((skill as any).tags) ? ((skill as any).tags as unknown[]).map(String) : [],
            installed: !!skill,
            latestVersion: skill ? toLatestVersionDto(latest) : null,
            installs: ref.installs,
            sourceType: ref.ref.sourceType,
            sourceKey: ref.ref.sourceKey,
            sourceRef: ref.ref.sourceRef,
            sourceRevision:
              latest && typeof (latest as any).sourceRevision === "string" ? String((latest as any).sourceRevision) : null,
            githubRepoUrl: ref.ref.githubRepoUrl,
            skillDir: ref.ref.skillDir,
          };
        });
        const nextCursor = null;

        return {
          success: true,
          data: { provider: effectiveProvider, items, nextCursor },
        };
      }

      if (effectiveProvider !== "registry") {
        return {
          success: false,
          error: { code: "BAD_INPUT", message: `不支持的 provider: ${effectiveProvider}` },
        };
      }

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
        include: { latestVersion: { select: { id: true, contentHash: true, importedAt: true } } },
      });

      const items = (skills as any[]).map((s) => {
        const latest = (s as any).latestVersion ?? null;
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

    server.post("/skills/import", { preHandler: requireAdmin }, async (request) => {
      if (!deps.skillsCli) {
        return { success: false, error: { code: "FEATURE_DISABLED", message: "skills.sh 导入未启用" } };
      }
      if (!deps.packages) {
        return { success: false, error: { code: "FEATURE_DISABLED", message: "技能包存储未配置" } };
      }

      const bodySchema = z.object({
        provider: z.string().min(1),
        sourceRef: z.string().min(1),
        mode: z.enum(["dry-run", "new-skill", "new-version"]).optional(),
      });
      const body = bodySchema.parse(request.body ?? {});

      const provider = body.provider.trim().toLowerCase() || "registry";
      if (provider !== "skills.sh") {
        return { success: false, error: { code: "BAD_INPUT", message: `不支持的 provider: ${provider}` } };
      }

      const source = parseSkillsShSourceKey(body.sourceRef);
      if (!source) {
        return { success: false, error: { code: "BAD_INPUT", message: "sourceRef 格式错误（期望 <owner>/<repo>@<skill>）" } };
      }

      const mode: SkillsShImportMode = body.mode ?? "new-version";
      const timeoutMs = Number(process.env.SKILLS_CLI_TIMEOUT_MS ?? "20000");

      const actor = (request as any)?.user && typeof (request as any).user === "object"
        ? { userId: String(((request as any).user as any).userId ?? ""), username: String(((request as any).user as any).username ?? "") }
        : null;

      const preparedRes = await prepareSkillsShImport({ skillsCli: deps.skillsCli, source, timeoutMs });
      try {
        const prepared = preparedRes.prepared;

        if (mode === "dry-run") {
          await writeSkillAuditLog(deps.prisma, {
            action: "import",
            actor,
            skillId: null,
            skillVersionId: null,
            sourceType: prepared.source.sourceType,
            sourceKey: prepared.source.sourceKey,
            payload: { mode, contentHash: prepared.contentHash, fileCount: prepared.fileCount, totalBytes: prepared.totalBytes },
          });

          return {
            success: true,
            data: {
              mode,
              source: prepared.source,
              meta: prepared.meta,
              contentHash: prepared.contentHash,
              fileCount: prepared.fileCount,
              totalBytes: prepared.totalBytes,
            },
          };
        }

        const packaged = await packageSkillsShPrepared({ packages: deps.packages, prepared });

        const saved = await deps.prisma.$transaction(async (tx: any) => {
          const existing = await tx.skill.findFirst({
            where: { sourceType: prepared.source.sourceType, sourceKey: prepared.source.sourceKey },
          });

          const createdSkill = !existing;
          const skill = existing
            ? existing
            : await tx.skill.create({
                data: {
                  id: uuidv7(),
                  name: await resolveUniqueSkillName(tx, prepared.meta.name, prepared.source.sourceKey),
                  description: prepared.meta.description,
                  tags: prepared.meta.tags,
                  sourceType: prepared.source.sourceType,
                  sourceKey: prepared.source.sourceKey,
                },
              });

          const existingVersion = await tx.skillVersion.findFirst({
            where: { skillId: skill.id, contentHash: prepared.contentHash },
          });
          if (existingVersion) {
            if (!existingVersion.storageUri) {
              await tx.skillVersion.update({
                where: { id: existingVersion.id },
                data: { storageUri: packaged.storageUri, packageSize: packaged.packageSize, manifestJson: prepared.manifestJson } as any,
              });
            }

            await writeSkillAuditLog(tx, {
              action: "import",
              actor,
              skillId: skill.id,
              skillVersionId: existingVersion.id,
              sourceType: prepared.source.sourceType,
              sourceKey: prepared.source.sourceKey,
              payload: { mode, contentHash: prepared.contentHash, idempotent: true },
            });

            return { skill, skillVersion: existingVersion, createdSkill, createdVersion: false, published: false };
          }

          const skillVersion = await tx.skillVersion.create({
            data: {
              id: uuidv7(),
              skillId: skill.id,
              contentHash: prepared.contentHash,
              storageUri: packaged.storageUri,
              source: { ...prepared.source, provider: "skills.sh" },
              sourceRevision: null,
              packageSize: packaged.packageSize,
              manifestJson: prepared.manifestJson,
            } as any,
          });

          await writeSkillAuditLog(tx, {
            action: "import",
            actor,
            skillId: skill.id,
            skillVersionId: skillVersion.id,
            sourceType: prepared.source.sourceType,
            sourceKey: prepared.source.sourceKey,
            payload: { mode, contentHash: prepared.contentHash, idempotent: false },
          });

          let published = false;
          if (!skill.latestVersionId) {
            const updated = await tx.skill.update({
              where: { id: skill.id },
              data: { latestVersionId: skillVersion.id } as any,
            });
            published = !!updated;
            await writeSkillAuditLog(tx, {
              action: "publish_latest",
              actor,
              skillId: skill.id,
              fromVersionId: null,
              toVersionId: skillVersion.id,
              sourceType: prepared.source.sourceType,
              sourceKey: prepared.source.sourceKey,
            });
          }

          return { skill, skillVersion, createdSkill, createdVersion: true, published };
        });

        return {
          success: true,
          data: {
            mode,
            source: prepared.source,
            meta: prepared.meta,
            contentHash: prepared.contentHash,
            fileCount: prepared.fileCount,
            totalBytes: prepared.totalBytes,
            skill: {
              id: String(saved.skill.id ?? ""),
              name: String(saved.skill.name ?? ""),
              description: saved.skill.description ?? null,
              tags: Array.isArray(saved.skill.tags) ? (saved.skill.tags as unknown[]).map(String) : [],
              sourceType: saved.skill.sourceType ?? null,
              sourceKey: saved.skill.sourceKey ?? null,
              latestVersionId: saved.skill.latestVersionId ?? null,
            },
            skillVersion: {
              id: String(saved.skillVersion.id ?? ""),
              contentHash: String(saved.skillVersion.contentHash ?? ""),
              storageUri: saved.skillVersion.storageUri ?? null,
              importedAt: saved.skillVersion.importedAt instanceof Date ? saved.skillVersion.importedAt.toISOString() : String(saved.skillVersion.importedAt ?? ""),
            },
            createdSkill: saved.createdSkill,
            createdVersion: saved.createdVersion,
            published: saved.published,
          },
        };
      } catch (err) {
        try {
          (request as any)?.log?.error?.(
            { err: String(err), sourceType: source.sourceType, sourceKey: source.sourceKey },
            "skills import failed",
          );
        } catch {
          // ignore
        }
        throw err;
      } finally {
        await preparedRes.cleanup().catch(() => {});
      }
    });

    server.post("/skills/check-updates", { preHandler: requireAdmin }, async (request) => {
      if (!deps.skillsCli) {
        return { success: false, error: { code: "FEATURE_DISABLED", message: "skills.sh 更新检查未启用" } };
      }

      const bodySchema = z.object({
        skillIds: z.array(z.string().uuid()).max(200).optional(),
        sourceType: z.string().optional(),
      });
      const body = bodySchema.parse(request.body ?? {});

      const actor = (request as any)?.user && typeof (request as any).user === "object"
        ? { userId: String(((request as any).user as any).userId ?? ""), username: String(((request as any).user as any).username ?? "") }
        : null;

      const where: any = {
        sourceType: body.sourceType ? body.sourceType.trim() : { not: null },
        sourceKey: { not: null },
        ...(body.skillIds?.length ? { id: { in: body.skillIds } } : {}),
      };

      const skills = await deps.prisma.skill.findMany({
        where,
        select: { id: true, name: true, sourceType: true, sourceKey: true, latestVersionId: true },
        orderBy: { updatedAt: "desc" },
        take: 500,
      } as any);

      const timeoutMs = Number(process.env.SKILLS_CLI_TIMEOUT_MS ?? "20000");
      const items: any[] = [];

      for (const s of skills as any[]) {
        const skillId = String(s.id ?? "");
        const sourceType = typeof s.sourceType === "string" ? String(s.sourceType) : "";
        const sourceKey = typeof s.sourceKey === "string" ? String(s.sourceKey) : "";
        const name = String(s.name ?? "");

        if (sourceType !== "skills.sh" || !sourceKey) continue;
        const source = parseSkillsShSourceKey(sourceKey);
        if (!source) continue;

        let cleanup: (() => Promise<void>) | null = null;
        try {
          const preparedRes = await prepareSkillsShImport({ skillsCli: deps.skillsCli, source, timeoutMs });
          cleanup = preparedRes.cleanup;
          const prepared = preparedRes.prepared;

          const currentVersion =
            s.latestVersionId
              ? await deps.prisma.skillVersion.findUnique({
                  where: { id: String(s.latestVersionId) },
                  select: { id: true, contentHash: true },
                } as any)
              : await deps.prisma.skillVersion.findFirst({
                  where: { skillId },
                  orderBy: { importedAt: "desc" },
                  select: { id: true, contentHash: true },
                } as any);

          const existsSame = await deps.prisma.skillVersion.findFirst({
            where: { skillId, contentHash: prepared.contentHash },
            select: { id: true },
          } as any);

          const currentHash = currentVersion?.contentHash ? String(currentVersion.contentHash) : null;
          const hasUpdate = !existsSame && !!currentHash && prepared.contentHash !== currentHash;

          items.push({
            skillId,
            name,
            sourceType,
            sourceKey,
            current: currentVersion
              ? { versionId: String(currentVersion.id ?? ""), contentHash: String(currentVersion.contentHash ?? "") }
              : null,
            candidate: { contentHash: prepared.contentHash, fileCount: prepared.fileCount, totalBytes: prepared.totalBytes },
            hasUpdate,
          });

          await writeSkillAuditLog(deps.prisma, {
            action: "check_updates",
            actor,
            skillId,
            sourceType,
            sourceKey,
            payload: { candidateContentHash: prepared.contentHash, currentContentHash: currentHash, hasUpdate },
          });
        } catch (err) {
          try {
            (request as any)?.log?.error?.({ err: String(err), skillId }, "skills check-updates failed");
          } catch {
            // ignore
          }
          items.push({ skillId, name, sourceType, sourceKey, error: String(err) });
          await writeSkillAuditLog(deps.prisma, {
            action: "check_updates",
            actor,
            skillId,
            sourceType,
            sourceKey,
            payload: { error: String(err) },
          });
        } finally {
          if (cleanup) await cleanup().catch(() => {});
        }
      }

      return { success: true, data: { items } };
    });

    server.post("/skills/update", { preHandler: requireAdmin }, async (request) => {
      if (!deps.skillsCli) {
        return { success: false, error: { code: "FEATURE_DISABLED", message: "skills.sh 更新未启用" } };
      }
      if (!deps.packages) {
        return { success: false, error: { code: "FEATURE_DISABLED", message: "技能包存储未配置" } };
      }

      const bodySchema = z.object({
        skillIds: z.array(z.string().uuid()).min(1).max(50),
        publishLatest: z.boolean().optional().default(false),
      });
      const body = bodySchema.parse(request.body ?? {});

      const actor = (request as any)?.user && typeof (request as any).user === "object"
        ? { userId: String(((request as any).user as any).userId ?? ""), username: String(((request as any).user as any).username ?? "") }
        : null;

      const timeoutMs = Number(process.env.SKILLS_CLI_TIMEOUT_MS ?? "20000");
      const results: any[] = [];

      for (const skillId of body.skillIds) {
        const skill = await deps.prisma.skill.findUnique({
          where: { id: skillId },
          select: { id: true, name: true, sourceType: true, sourceKey: true, latestVersionId: true },
        } as any);
        if (!skill) {
          results.push({ skillId, ok: false, error: "NOT_FOUND" });
          continue;
        }

        const sourceType = typeof (skill as any).sourceType === "string" ? String((skill as any).sourceType) : "";
        const sourceKey = typeof (skill as any).sourceKey === "string" ? String((skill as any).sourceKey) : "";
        if (sourceType !== "skills.sh" || !sourceKey) {
          results.push({ skillId, ok: false, error: "UNSUPPORTED_SOURCE" });
          continue;
        }
        const source = parseSkillsShSourceKey(sourceKey);
        if (!source) {
          results.push({ skillId, ok: false, error: "BAD_SOURCE_KEY" });
          continue;
        }

        const preparedRes = await prepareSkillsShImport({ skillsCli: deps.skillsCli, source, timeoutMs });
        try {
          const prepared = preparedRes.prepared;
          const packaged = await packageSkillsShPrepared({ packages: deps.packages, prepared });

          const saved = await deps.prisma.$transaction(async (tx: any) => {
            const existingVersion = await tx.skillVersion.findFirst({
              where: { skillId, contentHash: prepared.contentHash },
            });

            if (existingVersion) {
              if (!existingVersion.storageUri) {
                await tx.skillVersion.update({
                  where: { id: existingVersion.id },
                  data: { storageUri: packaged.storageUri, packageSize: packaged.packageSize, manifestJson: prepared.manifestJson } as any,
                });
              }

              await writeSkillAuditLog(tx, {
                action: "update",
                actor,
                skillId,
                skillVersionId: existingVersion.id,
                sourceType,
                sourceKey,
                payload: { idempotent: true, contentHash: prepared.contentHash },
              });

              return { skillVersion: existingVersion, createdVersion: false, published: false };
            }

            const skillVersion = await tx.skillVersion.create({
              data: {
                id: uuidv7(),
                skillId,
                contentHash: prepared.contentHash,
                storageUri: packaged.storageUri,
                source: { ...prepared.source, provider: "skills.sh" },
                sourceRevision: null,
                packageSize: packaged.packageSize,
                manifestJson: prepared.manifestJson,
              } as any,
            });

            await writeSkillAuditLog(tx, {
              action: "update",
              actor,
              skillId,
              skillVersionId: skillVersion.id,
              sourceType,
              sourceKey,
              payload: { idempotent: false, contentHash: prepared.contentHash },
            });

            let published = false;
            if (body.publishLatest) {
              const prev = (skill as any).latestVersionId ? String((skill as any).latestVersionId) : null;
              await tx.skill.update({ where: { id: skillId }, data: { latestVersionId: skillVersion.id } as any });
              published = true;
              await writeSkillAuditLog(tx, {
                action: "publish_latest",
                actor,
                skillId,
                fromVersionId: prev,
                toVersionId: skillVersion.id,
                sourceType,
                sourceKey,
              });
            }

            return { skillVersion, createdVersion: true, published };
          });

          results.push({
            skillId,
            ok: true,
            createdVersion: saved.createdVersion,
            published: saved.published,
            contentHash: prepared.contentHash,
            storageUri: packaged.storageUri,
            skillVersionId: String(saved.skillVersion.id ?? ""),
          });
        } catch (err) {
          try {
            (request as any)?.log?.error?.({ err: String(err), skillId }, "skills update failed");
          } catch {
            // ignore
          }
          results.push({ skillId, ok: false, error: String(err) });
        } finally {
          await preparedRes.cleanup().catch(() => {});
        }
      }

      return { success: true, data: { publishLatest: body.publishLatest, results } };
    });

    server.post("/skills/:skillId/publish-latest", { preHandler: requireAdmin }, async (request) => {
      const paramsSchema = z.object({ skillId: z.string().uuid() });
      const bodySchema = z.object({ versionId: z.string().uuid() });
      const { skillId } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      const actor = (request as any)?.user && typeof (request as any).user === "object"
        ? { userId: String(((request as any).user as any).userId ?? ""), username: String(((request as any).user as any).username ?? "") }
        : null;

      const skill = await deps.prisma.skill.findUnique({
        where: { id: skillId },
        select: { id: true, latestVersionId: true, sourceType: true, sourceKey: true },
      } as any);
      if (!skill) return { success: false, error: { code: "NOT_FOUND", message: "Skill 不存在" } };

      const version = await deps.prisma.skillVersion.findFirst({
        where: { id: body.versionId, skillId },
        select: { id: true, importedAt: true },
      } as any);
      if (!version) {
        return { success: false, error: { code: "BAD_INPUT", message: "versionId 不存在或不属于该 Skill" } };
      }

      const fromVersionId = skill.latestVersionId ? String(skill.latestVersionId) : null;
      if (fromVersionId === version.id) {
        return { success: true, data: { skillId, latestVersionId: fromVersionId } };
      }

      let action: "publish_latest" | "rollback_latest" = "publish_latest";
      if (fromVersionId) {
        const prev = await deps.prisma.skillVersion.findUnique({
          where: { id: fromVersionId },
          select: { importedAt: true },
        } as any);
        const prevAt = prev?.importedAt instanceof Date ? prev.importedAt.getTime() : NaN;
        const nextAt = version.importedAt instanceof Date ? version.importedAt.getTime() : NaN;
        if (Number.isFinite(prevAt) && Number.isFinite(nextAt) && nextAt < prevAt) action = "rollback_latest";
      }

      await deps.prisma.skill.update({ where: { id: skillId }, data: { latestVersionId: version.id } as any });
      await writeSkillAuditLog(deps.prisma, {
        action,
        actor,
        skillId,
        fromVersionId,
        toVersionId: version.id,
        sourceType: skill.sourceType ?? null,
        sourceKey: skill.sourceKey ?? null,
      });

      return { success: true, data: { skillId, latestVersionId: version.id } };
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
            sourceRevision: typeof (v as any).sourceRevision === "string" ? String((v as any).sourceRevision) : null,
            packageSize: typeof (v as any).packageSize === "number" && Number.isFinite((v as any).packageSize) ? Number((v as any).packageSize) : null,
            manifestJson: (v as any).manifestJson ?? null,
            importedAt: v.importedAt,
          })),
        },
      };
    });
  };
}
