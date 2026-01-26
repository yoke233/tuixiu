-- Add project-level workspace and git auth modes (worktree vs clone, https_pat vs ssh).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "workspaceMode" VARCHAR(20) NOT NULL DEFAULT 'worktree',
ADD COLUMN     "gitAuthMode" VARCHAR(20) NOT NULL DEFAULT 'https_pat';

