-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "executionProfileId" UUID,
ADD COLUMN     "workspacePolicy" VARCHAR(20);

-- AlterTable
ALTER TABLE "RoleTemplate" ADD COLUMN     "executionProfileId" UUID,
ADD COLUMN     "workspacePolicy" VARCHAR(20);

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "executionProfileId" UUID,
ADD COLUMN     "executionProfileSnapshot" JSONB,
ADD COLUMN     "resolvedWorkspacePolicy" VARCHAR(20),
ADD COLUMN     "workspacePolicySource" JSONB;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "executionProfileId" UUID,
ADD COLUMN     "executionProfileSnapshot" JSONB,
ADD COLUMN     "resolvedWorkspacePolicy" VARCHAR(20),
ADD COLUMN     "workspacePolicySource" JSONB;

-- CreateTable
CREATE TABLE "ExecutionProfile" (
    "id" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "displayName" VARCHAR(255),
    "description" TEXT,
    "workspacePolicy" VARCHAR(20),
    "skillsPolicy" VARCHAR(20),
    "toolPolicy" JSONB,
    "dataPolicy" JSONB,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionProfileAuditLog" (
    "id" UUID NOT NULL,
    "executionProfileId" UUID NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actorUserId" UUID,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionProfileAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionProfile_key_key" ON "ExecutionProfile"("key");

-- CreateIndex
CREATE INDEX "ExecutionProfile_createdAt_idx" ON "ExecutionProfile"("createdAt");

-- CreateIndex
CREATE INDEX "ExecutionProfileAuditLog_executionProfileId_createdAt_idx" ON "ExecutionProfileAuditLog"("executionProfileId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExecutionProfileAuditLog_action_createdAt_idx" ON "ExecutionProfileAuditLog"("action", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleTemplate" ADD CONSTRAINT "RoleTemplate_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionProfile" ADD CONSTRAINT "ExecutionProfile_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionProfile" ADD CONSTRAINT "ExecutionProfile_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionProfileAuditLog" ADD CONSTRAINT "ExecutionProfileAuditLog_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionProfileAuditLog" ADD CONSTRAINT "ExecutionProfileAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_executionProfileId_fkey" FOREIGN KEY ("executionProfileId") REFERENCES "ExecutionProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
