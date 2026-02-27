import type { PrismaDeps } from "../db.js";
import { isPlatformScope } from "./sharedScopes.js";

export function isCredentialUsableForProject(
  credential: unknown,
  projectId: unknown,
): boolean {
  const project = String(projectId ?? "").trim();
  if (!credential || !project) return false;

  if (isPlatformScope((credential as any)?.scope)) return true;
  return String((credential as any)?.projectId ?? "").trim() === project;
}

export async function loadProjectCredentials(
  prisma: PrismaDeps,
  project: { id?: unknown; runGitCredentialId?: unknown; scmAdminCredentialId?: unknown },
): Promise<{ run: any | null; admin: any | null }> {
  const projectId = String(project?.id ?? "").trim();
  const runId = String(project?.runGitCredentialId ?? "").trim();
  const adminId = String(project?.scmAdminCredentialId ?? "").trim();

  const ids = Array.from(new Set([runId, adminId].filter(Boolean)));
  if (!ids.length) return { run: null, admin: null };

  const findMany = (prisma as any)?.gitCredential?.findMany;
  if (typeof findMany !== "function") return { run: null, admin: null };

  const rows = await findMany.call(prisma.gitCredential, { where: { id: { in: ids } } as any }).catch(() => [] as any[]);

  const byId = new Map<string, any>();
  for (const row of rows) {
    const id = String((row as any)?.id ?? "").trim();
    if (id) byId.set(id, row);
  }

  let run = runId ? (byId.get(runId) ?? null) : null;
  let admin = adminId ? (byId.get(adminId) ?? null) : null;

  if (projectId) {
    if (run && !isCredentialUsableForProject(run, projectId)) run = null;
    if (admin && !isCredentialUsableForProject(admin, projectId)) admin = null;
  }

  return { run, admin };
}
