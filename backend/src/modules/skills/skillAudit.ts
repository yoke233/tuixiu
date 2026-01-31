import type { PrismaDeps } from "../../db.js";

export async function writeSkillAuditLog(
  prisma: PrismaDeps,
  input: {
    action: "import" | "check_updates" | "update" | "publish_latest" | "rollback_latest" | "bind_change";
    actor: { userId: string; username: string } | null;
    skillId?: string | null;
    skillVersionId?: string | null;
    projectId?: string | null;
    roleTemplateId?: string | null;
    sourceType?: string | null;
    sourceKey?: string | null;
    sourceRevision?: string | null;
    fromVersionId?: string | null;
    toVersionId?: string | null;
    payload?: unknown;
  },
): Promise<void> {
  const create = (prisma as any)?.skillAuditLog?.create;
  if (typeof create !== "function") return;

  await (prisma as any).skillAuditLog
    .create({
      data: {
        action: input.action as any,
        actorUserId: input.actor?.userId ?? null,
        actorUsername: input.actor?.username ?? null,
        skillId: input.skillId ?? null,
        skillVersionId: input.skillVersionId ?? null,
        projectId: input.projectId ?? null,
        roleTemplateId: input.roleTemplateId ?? null,
        sourceType: input.sourceType ?? null,
        sourceKey: input.sourceKey ?? null,
        sourceRevision: input.sourceRevision ?? null,
        fromVersionId: input.fromVersionId ?? null,
        toVersionId: input.toVersionId ?? null,
        payload: input.payload ?? null,
      } as any,
    })
    .catch(() => {});
}
