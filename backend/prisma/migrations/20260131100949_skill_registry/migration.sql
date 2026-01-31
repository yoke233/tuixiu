-- CreateEnum
CREATE TYPE "SkillVersionPolicy" AS ENUM ('latest', 'pinned');

-- DropIndex
DROP INDEX "Issue_archivedAt_idx";

-- DropIndex
DROP INDEX "Run_sandboxStatus_idx";

-- CreateTable
CREATE TABLE "Skill" (
    "id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillVersion" (
    "id" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "contentHash" VARCHAR(128) NOT NULL,
    "storageUri" VARCHAR(500),
    "source" JSONB,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleSkillBinding" (
    "id" UUID NOT NULL,
    "roleTemplateId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "versionPolicy" "SkillVersionPolicy" NOT NULL DEFAULT 'latest',
    "pinnedVersionId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleSkillBinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_name_key" ON "Skill"("name");

-- CreateIndex
CREATE INDEX "Skill_updatedAt_idx" ON "Skill"("updatedAt");

-- CreateIndex
CREATE INDEX "SkillVersion_skillId_importedAt_idx" ON "SkillVersion"("skillId", "importedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skillId_contentHash_key" ON "SkillVersion"("skillId", "contentHash");

-- CreateIndex
CREATE INDEX "RoleSkillBinding_roleTemplateId_idx" ON "RoleSkillBinding"("roleTemplateId");

-- CreateIndex
CREATE INDEX "RoleSkillBinding_skillId_idx" ON "RoleSkillBinding"("skillId");

-- CreateIndex
CREATE INDEX "RoleSkillBinding_pinnedVersionId_idx" ON "RoleSkillBinding"("pinnedVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleSkillBinding_roleTemplateId_skillId_key" ON "RoleSkillBinding"("roleTemplateId", "skillId");

-- AddForeignKey
ALTER TABLE "SkillVersion" ADD CONSTRAINT "SkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleSkillBinding" ADD CONSTRAINT "RoleSkillBinding_roleTemplateId_fkey" FOREIGN KEY ("roleTemplateId") REFERENCES "RoleTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleSkillBinding" ADD CONSTRAINT "RoleSkillBinding_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleSkillBinding" ADD CONSTRAINT "RoleSkillBinding_pinnedVersionId_fkey" FOREIGN KEY ("pinnedVersionId") REFERENCES "SkillVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
