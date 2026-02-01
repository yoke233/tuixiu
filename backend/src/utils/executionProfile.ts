import type { PrismaDeps } from "../db.js";

export type ExecutionProfileSnapshot = {
  id: string;
  key?: string | null;
  displayName?: string | null;
  description?: string | null;
  workspacePolicy?: string | null;
  skillsPolicy?: string | null;
  toolPolicy?: unknown;
  dataPolicy?: unknown;
  source: "task" | "role" | "project" | "platform";
};

export async function resolveExecutionProfile(opts: {
  prisma: PrismaDeps;
  platformProfileKey?: string | null;
  taskProfileId?: string | null;
  roleProfileId?: string | null;
  projectProfileId?: string | null;
}): Promise<ExecutionProfileSnapshot | null> {
  const { prisma } = opts;
  if (opts.taskProfileId) {
    const profile = await prisma.executionProfile.findUnique({ where: { id: opts.taskProfileId } });
    if (profile) return toSnapshot(profile, "task");
  }
  if (opts.roleProfileId) {
    const profile = await prisma.executionProfile.findUnique({ where: { id: opts.roleProfileId } });
    if (profile) return toSnapshot(profile, "role");
  }
  if (opts.projectProfileId) {
    const profile = await prisma.executionProfile.findUnique({
      where: { id: opts.projectProfileId },
    });
    if (profile) return toSnapshot(profile, "project");
  }
  if (opts.platformProfileKey) {
    const profile = await prisma.executionProfile.findUnique({
      where: { key: opts.platformProfileKey },
    });
    if (profile) return toSnapshot(profile, "platform");
  }
  return null;
}

function toSnapshot(profile: any, source: ExecutionProfileSnapshot["source"]): ExecutionProfileSnapshot {
  return {
    id: String(profile.id),
    key: profile.key ?? null,
    displayName: profile.displayName ?? null,
    description: profile.description ?? null,
    workspacePolicy: profile.workspacePolicy ?? null,
    skillsPolicy: profile.skillsPolicy ?? null,
    toolPolicy: profile.toolPolicy ?? null,
    dataPolicy: profile.dataPolicy ?? null,
    source,
  };
}
