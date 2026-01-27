-- Add per-project workspace notice template for agent prompt.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "agentWorkspaceNoticeTemplate" TEXT;

