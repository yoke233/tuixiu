-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('pending', 'running', 'reviewing', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('local', 'remote');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('online', 'offline', 'degraded', 'suspended');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('pending', 'running', 'waiting_ci', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('acp', 'gitlab', 'system', 'user');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('branch', 'mr', 'patch', 'report', 'ci_result');

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "repoUrl" VARCHAR(500) NOT NULL,
    "scmType" VARCHAR(20) NOT NULL DEFAULT 'gitlab',
    "defaultBranch" VARCHAR(100) NOT NULL DEFAULT 'main',
    "gitlabProjectId" INTEGER,
    "gitlabAccessToken" TEXT,
    "gitlabWebhookSecret" VARCHAR(255),
    "branchProtection" JSONB,
    "agentAllocationStrategy" VARCHAR(20),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "acceptanceCriteria" JSONB,
    "constraints" JSONB,
    "testRequirements" TEXT,
    "status" "IssueStatus" NOT NULL DEFAULT 'pending',
    "assignedAgentId" UUID,
    "createdBy" VARCHAR(100),
    "labels" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "type" "AgentType" NOT NULL DEFAULT 'local',
    "proxyId" VARCHAR(100),
    "gatewayId" VARCHAR(100),
    "capabilities" JSONB,
    "status" "AgentStatus" NOT NULL DEFAULT 'offline',
    "currentLoad" INTEGER NOT NULL DEFAULT 0,
    "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 2,
    "lastHeartbeat" TIMESTAMP(3),
    "healthCheckInterval" INTEGER NOT NULL DEFAULT 30,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "acpSessionId" VARCHAR(100),
    "workspaceType" VARCHAR(20),
    "workspacePath" VARCHAR(500),
    "branchName" VARCHAR(200),
    "status" "RunStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "failureReason" VARCHAR(100),
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "source" "EventSource" NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "payload" JSONB,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_gitlabProjectId_key" ON "Project"("gitlabProjectId");

-- CreateIndex
CREATE INDEX "Project_gitlabProjectId_idx" ON "Project"("gitlabProjectId");

-- CreateIndex
CREATE INDEX "Issue_projectId_status_idx" ON "Issue"("projectId", "status");

-- CreateIndex
CREATE INDEX "Issue_assignedAgentId_idx" ON "Issue"("assignedAgentId");

-- CreateIndex
CREATE INDEX "Issue_status_idx" ON "Issue"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_proxyId_key" ON "Agent"("proxyId");

-- CreateIndex
CREATE INDEX "Agent_status_currentLoad_idx" ON "Agent"("status", "currentLoad");

-- CreateIndex
CREATE INDEX "Agent_proxyId_idx" ON "Agent"("proxyId");

-- CreateIndex
CREATE INDEX "Agent_lastHeartbeat_idx" ON "Agent"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "Run_issueId_idx" ON "Run"("issueId");

-- CreateIndex
CREATE INDEX "Run_agentId_status_idx" ON "Run"("agentId", "status");

-- CreateIndex
CREATE INDEX "Run_acpSessionId_idx" ON "Run"("acpSessionId");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Event_runId_timestamp_idx" ON "Event"("runId", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "Event_type_idx" ON "Event"("type");

-- CreateIndex
CREATE INDEX "Event_source_idx" ON "Event"("source");

-- CreateIndex
CREATE INDEX "Artifact_runId_type_idx" ON "Artifact"("runId", "type");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
