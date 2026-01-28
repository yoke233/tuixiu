-- Add per-run sandbox metadata and sandbox inventory table.

-- CreateEnum
CREATE TYPE "SandboxStatus" AS ENUM ('creating', 'running', 'stopped', 'missing', 'error');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "sandboxInstanceName" VARCHAR(200),
ADD COLUMN     "keepaliveTtlSeconds" INTEGER,
ADD COLUMN     "sandboxStatus" "SandboxStatus",
ADD COLUMN     "sandboxLastSeenAt" TIMESTAMP(3),
ADD COLUMN     "sandboxLastError" TEXT;

-- CreateTable
CREATE TABLE "SandboxInstance" (
    "id" UUID NOT NULL,
    "proxyId" VARCHAR(100) NOT NULL,
    "instanceName" VARCHAR(200) NOT NULL,
    "runId" UUID,
    "provider" VARCHAR(50),
    "runtime" VARCHAR(50),
    "status" "SandboxStatus",
    "createdAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "SandboxInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SandboxInstance_proxyId_instanceName_key" ON "SandboxInstance"("proxyId", "instanceName");

-- CreateIndex
CREATE INDEX "SandboxInstance_proxyId_idx" ON "SandboxInstance"("proxyId");

-- CreateIndex
CREATE INDEX "SandboxInstance_runId_idx" ON "SandboxInstance"("runId");

-- CreateIndex
CREATE INDEX "SandboxInstance_status_idx" ON "SandboxInstance"("status");

-- CreateIndex
CREATE INDEX "SandboxInstance_lastSeenAt_idx" ON "SandboxInstance"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Run_sandboxStatus_idx" ON "Run"("sandboxStatus");

-- AddForeignKey
ALTER TABLE "SandboxInstance" ADD CONSTRAINT "SandboxInstance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

