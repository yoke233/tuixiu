import type { PrismaDeps } from "../db.js";

import { SHARED_SCOPE_PLATFORM } from "./sharedScopes.js";

function normalizeKey(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeProjectId(value: unknown): string {
  return String(value ?? "").trim();
}

export async function findEffectiveRoleTemplate(
  prisma: PrismaDeps,
  opts: { projectId: unknown; roleKey: unknown },
): Promise<any | null> {
  const projectId = normalizeProjectId(opts.projectId);
  const roleKey = normalizeKey(opts.roleKey);
  if (!projectId || !roleKey) return null;

  const projectRole = await prisma.roleTemplate.findFirst({
    where: { projectId, key: roleKey } as any,
  });
  if (projectRole) return projectRole;

  return await prisma.roleTemplate.findFirst({
    where: {
      key: roleKey,
      scope: SHARED_SCOPE_PLATFORM,
      projectId: null,
    } as any,
  });
}

export async function listEffectiveRoleTemplates(
  prisma: PrismaDeps,
  opts: { projectId: unknown; includePlatform?: boolean; projectOrder?: "asc" | "desc" },
): Promise<any[]> {
  const projectId = normalizeProjectId(opts.projectId);
  if (!projectId) return [];

  const projectRoles = await prisma.roleTemplate.findMany({
    where: { projectId } as any,
    orderBy: { createdAt: opts.projectOrder ?? "desc" } as any,
  });

  if (!opts.includePlatform) return projectRoles;

  const platformRoles = await prisma.roleTemplate.findMany({
    where: { scope: SHARED_SCOPE_PLATFORM, projectId: null } as any,
    orderBy: { createdAt: "desc" } as any,
  });

  const projectKeys = new Set(
    projectRoles
      .map((r: any) => normalizeKey(r?.key))
      .filter(Boolean),
  );

  const merged = [...projectRoles];
  for (const role of platformRoles) {
    const key = normalizeKey((role as any)?.key);
    if (!key || projectKeys.has(key)) continue;
    merged.push(role);
  }

  return merged;
}
