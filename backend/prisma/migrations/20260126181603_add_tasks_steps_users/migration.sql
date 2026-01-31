-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'pm', 'reviewer', 'dev');

-- CreateEnum
CREATE TYPE "ExecutorType" AS ENUM ('agent', 'ci', 'human', 'system');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('pending', 'running', 'blocked', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "StepStatus" AS ENUM ('pending', 'ready', 'running', 'waiting_ci', 'waiting_human', 'blocked', 'completed', 'failed', 'cancelled');

-- DropForeignKey
ALTER TABLE "Run" DROP CONSTRAINT "Run_agentId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "Issue_archivedAt_idx";

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "executorType" "ExecutorType" NOT NULL DEFAULT 'agent',
ADD COLUMN     "stepId" UUID,
ADD COLUMN     "taskId" UUID,
ALTER COLUMN "agentId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'dev',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "templateKey" VARCHAR(100) NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'pending',
    "currentStepId" UUID,
    "workspaceType" VARCHAR(20),
    "workspacePath" VARCHAR(500),
    "branchName" VARCHAR(200),
    "baseBranch" VARCHAR(100),
    "createdByUserId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Step" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "kind" VARCHAR(100) NOT NULL,
    "order" INTEGER NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'pending',
    "executorType" "ExecutorType" NOT NULL DEFAULT 'agent',
    "roleKey" VARCHAR(100),
    "params" JSONB,
    "dependsOn" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Task_currentStepId_key" ON "Task"("currentStepId");

-- CreateIndex
CREATE INDEX "Task_issueId_status_idx" ON "Task"("issueId", "status");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_createdByUserId_idx" ON "Task"("createdByUserId");

-- CreateIndex
CREATE INDEX "Step_taskId_order_idx" ON "Step"("taskId", "order");

-- CreateIndex
CREATE INDEX "Step_taskId_status_idx" ON "Step"("taskId", "status");

-- CreateIndex
CREATE INDEX "Step_status_idx" ON "Step"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Step_taskId_key_key" ON "Step"("taskId", "key");

-- CreateIndex
CREATE INDEX "Run_taskId_startedAt_idx" ON "Run"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "Run_stepId_startedAt_idx" ON "Run"("stepId", "startedAt");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_currentStepId_fkey" FOREIGN KEY ("currentStepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Step" ADD CONSTRAINT "Step_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
