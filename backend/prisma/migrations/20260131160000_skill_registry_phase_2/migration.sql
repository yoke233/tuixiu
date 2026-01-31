-- CreateEnum
CREATE TYPE "SkillAuditAction" AS ENUM ('import', 'check_updates', 'update', 'publish_latest', 'rollback_latest', 'bind_change');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "enableRuntimeSkillsMounting" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Skill" ADD COLUMN     "latestVersionId" UUID,
ADD COLUMN     "sourceKey" VARCHAR(300),
ADD COLUMN     "sourceType" VARCHAR(50);

-- AlterTable
ALTER TABLE "SkillVersion" ADD COLUMN     "manifestJson" JSONB,
ADD COLUMN     "packageSize" INTEGER,
ADD COLUMN     "sourceRevision" VARCHAR(100);

-- CreateTable
CREATE TABLE "SkillAuditLog" (
    "id" UUID NOT NULL,
    "action" "SkillAuditAction" NOT NULL,
    "actorUserId" UUID,
    "actorUsername" VARCHAR(100),
    "skillId" UUID,
    "skillVersionId" UUID,
    "projectId" UUID,
    "roleTemplateId" UUID,
    "sourceType" VARCHAR(50),
    "sourceKey" VARCHAR(300),
    "sourceRevision" VARCHAR(100),
    "fromVersionId" UUID,
    "toVersionId" UUID,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SkillAuditLog_createdAt_idx" ON "SkillAuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "SkillAuditLog_action_createdAt_idx" ON "SkillAuditLog"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SkillAuditLog_skillId_createdAt_idx" ON "SkillAuditLog"("skillId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SkillAuditLog_projectId_roleTemplateId_createdAt_idx" ON "SkillAuditLog"("projectId", "roleTemplateId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SkillAuditLog_sourceType_sourceKey_idx" ON "SkillAuditLog"("sourceType", "sourceKey");

-- CreateIndex
CREATE INDEX "Skill_latestVersionId_idx" ON "Skill"("latestVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_sourceType_sourceKey_key" ON "Skill"("sourceType", "sourceKey");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "SkillVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAuditLog" ADD CONSTRAINT "SkillAuditLog_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAuditLog" ADD CONSTRAINT "SkillAuditLog_skillVersionId_fkey" FOREIGN KEY ("skillVersionId") REFERENCES "SkillVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAuditLog" ADD CONSTRAINT "SkillAuditLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillAuditLog" ADD CONSTRAINT "SkillAuditLog_roleTemplateId_fkey" FOREIGN KEY ("roleTemplateId") REFERENCES "RoleTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

