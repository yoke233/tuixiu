-- Add GitHub external issue reference fields and project default role key.
-- Introduce RoleTemplate for project-scoped role initScript/prompt templates.

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "externalId" VARCHAR(100),
ADD COLUMN     "externalLabels" JSONB,
ADD COLUMN     "externalNumber" INTEGER,
ADD COLUMN     "externalProvider" VARCHAR(20),
ADD COLUMN     "externalState" VARCHAR(20),
ADD COLUMN     "externalUrl" VARCHAR(500),
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "defaultRoleKey" VARCHAR(100);

-- CreateTable
CREATE TABLE "RoleTemplate" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "displayName" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "promptTemplate" TEXT,
    "initScript" TEXT,
    "initTimeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoleTemplate_projectId_idx" ON "RoleTemplate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleTemplate_projectId_key_key" ON "RoleTemplate"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_projectId_externalProvider_externalId_key" ON "Issue"("projectId", "externalProvider", "externalId");

-- AddForeignKey
ALTER TABLE "RoleTemplate" ADD CONSTRAINT "RoleTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

