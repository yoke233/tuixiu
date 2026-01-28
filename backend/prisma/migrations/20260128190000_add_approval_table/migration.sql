-- Add Approval table (replace report Artifact for approvals).

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('merge_pr', 'create_pr', 'publish_artifact');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'executing', 'executed', 'failed');

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "action" "ApprovalAction" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requestedBy" VARCHAR(100),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" VARCHAR(100),
    "decidedAt" TIMESTAMP(3),
    "reason" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Approval_runId_createdAt_idx" ON "Approval"("runId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Approval_action_status_idx" ON "Approval"("action", "status");

-- CreateIndex
CREATE INDEX "Approval_status_createdAt_idx" ON "Approval"("status", "createdAt" DESC);

