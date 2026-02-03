import type { PrismaDeps } from "../db.js";

export async function loadProjectCredentials(
  prisma: PrismaDeps,
  project: { id?: unknown; runGitCredentialId?: unknown; scmAdminCredentialId?: unknown },
): Promise<{ run: any | null; admin: any | null }> {
  const projectId = String(project?.id ?? "").trim();
  const runId = String(project?.runGitCredentialId ?? "").trim();
  const adminId = String(project?.scmAdminCredentialId ?? "").trim();

  const ids = Array.from(new Set([runId, adminId].filter(Boolean)));
  if (!ids.length) return { run: null, admin: null };

  const rows = await prisma.gitCredential
    .findMany({ where: { id: { in: ids } } as any })
    .catch(() => [] as any[]);

  const byId = new Map<string, any>();
  for (const row of rows) {
    const id = String((row as any)?.id ?? "").trim();
    if (id) byId.set(id, row);
  }

  let run = runId ? (byId.get(runId) ?? null) : null;
  let admin = adminId ? (byId.get(adminId) ?? null) : null;

  if (projectId) {
    if (run && String((run as any)?.projectId ?? "") !== projectId) run = null;
    if (admin && String((admin as any)?.projectId ?? "") !== projectId) admin = null;
  }

  return { run, admin };
}

