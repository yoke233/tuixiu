import type { PrismaDeps, SendToAgent } from "../deps.js";

export type WorkspaceMode = "worktree" | "clone";

export type CreateWorkspaceResult = {
  workspaceMode?: WorkspaceMode;
  workspacePath: string;
  branchName: string;
  baseBranch?: string;
  repoRoot?: string;
  gitAuthMode?: string | null;
  timingsMs?: Record<string, number>;
};

export type CreateWorkspace = (opts: {
  runId: string;
  baseBranch: string;
  name: string;
}) => Promise<CreateWorkspaceResult>;

export type ExecutorDeps = {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  createWorkspace?: CreateWorkspace;
};

