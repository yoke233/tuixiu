import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps } from "../deps.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";

const execFileAsync = promisify(execFile);

export type RunChangeFile = {
  path: string;
  status: string;
  oldPath?: string;
};

export class RunGitChangeError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "NO_BRANCH" | "GIT_DIFF_FAILED",
    public readonly details?: string,
  ) {
    super(message);
  }
}

function parseNameStatus(output: string): RunChangeFile[] {
  const lines = output
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);
  const files: RunChangeFile[] = [];
  for (const line of lines) {
    const parts = line.split("\t").filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0];
    if (status.startsWith("R") && parts.length >= 3) {
      files.push({ status, oldPath: parts[1], path: parts[2] });
      continue;
    }
    files.push({ status, path: parts[1] });
  }
  return files;
}

function resolveBranch(run: any): string {
  const branchArtifact = (run.artifacts ?? []).find((a: any) => a.type === "branch");
  const branchFromArtifact = (branchArtifact?.content as any)?.branch;
  const branch = run.branchName || (typeof branchFromArtifact === "string" ? branchFromArtifact : "");
  if (typeof branch !== "string") return "";
  return branch.trim();
}

function resolveBaseBranch(run: any): string {
  const branchArtifact = (run.artifacts ?? []).find((a: any) => a.type === "branch");
  const baseFromArtifact = (branchArtifact?.content as any)?.baseBranch;
  const base = typeof baseFromArtifact === "string" ? baseFromArtifact : "";
  const trimmed = base.trim();
  if (trimmed) return trimmed;

  const fromProject = run?.issue?.project?.defaultBranch;
  if (typeof fromProject === "string" && fromProject.trim()) return fromProject.trim();
  return "main";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickBoxliteWorkspaceModeFromCaps(capabilities: unknown): "mount" | "git_clone" | null {
  if (!isRecord(capabilities)) return null;
  const sandbox = capabilities.sandbox;
  if (!isRecord(sandbox)) return null;
  if (sandbox.provider !== "boxlite_oci") return null;
  const boxlite = sandbox.boxlite;
  if (!isRecord(boxlite)) return "mount";
  return boxlite.workspaceMode === "git_clone" ? "git_clone" : "mount";
}

function isBoxliteGitCloneRun(run: any): boolean {
  const assignedCaps = run?.issue?.assignedAgent?.capabilities;
  const runCaps = run?.agent?.capabilities;
  const mode = pickBoxliteWorkspaceModeFromCaps(assignedCaps ?? runCaps);
  return mode === "git_clone";
}

async function fetchOriginBranch(cwd: string, env: NodeJS.ProcessEnv, branch: string): Promise<void> {
  const b = String(branch ?? "").trim();
  if (!b) return;
  await execFileAsync("git", ["fetch", "--prune", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], { cwd, env });
}

async function fetchForGitCloneBestEffort(opts: { cwd: string; project: any; branches: string[] }): Promise<void> {
  let env: NodeJS.ProcessEnv = process.env;
  let cleanup: (() => Promise<void>) | null = null;
  try {
    const created = await createGitProcessEnv(opts.project);
    env = created.env;
    cleanup = created.cleanup;
  } catch {
    env = process.env;
    cleanup = null;
  }

  try {
    for (const b of opts.branches) {
      await fetchOriginBranch(opts.cwd, env, b).catch(() => {});
    }
  } finally {
    await cleanup?.().catch(() => {});
  }
}

async function gitDiffNameStatus(opts: { cwd: string; baseRef: string; headRef: string }): Promise<RunChangeFile[]> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-status", `${opts.baseRef}...${opts.headRef}`], {
    cwd: opts.cwd,
  });
  return parseNameStatus(stdout);
}

export async function getRunChanges(opts: { prisma: PrismaDeps; runId: string }): Promise<{
  baseBranch: string;
  branch: string;
  files: RunChangeFile[];
}> {
  const run = await opts.prisma.run.findUnique({
    where: { id: opts.runId },
    include: {
      agent: { select: { id: true, capabilities: true } } as any,
      issue: { include: { project: true, assignedAgent: { select: { id: true, capabilities: true } } } } as any,
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!run) {
    throw new RunGitChangeError("Run 不存在", "NOT_FOUND");
  }

  const baseBranch = resolveBaseBranch(run);
  const branch = resolveBranch(run);
  if (!branch) {
    throw new RunGitChangeError("Run 暂无 branch 信息", "NO_BRANCH");
  }

  const cwd = typeof run.workspacePath === "string" && run.workspacePath.trim() ? run.workspacePath.trim() : process.cwd();

  try {
    if (isBoxliteGitCloneRun(run)) {
      await fetchForGitCloneBestEffort({ cwd, project: (run as any).issue.project, branches: [baseBranch, branch] });
      try {
        const files = await gitDiffNameStatus({ cwd, baseRef: `origin/${baseBranch}`, headRef: `origin/${branch}` });
        return { baseBranch, branch, files };
      } catch {
        const files = await gitDiffNameStatus({ cwd, baseRef: baseBranch, headRef: branch });
        return { baseBranch, branch, files };
      }
    }

    const files = await gitDiffNameStatus({ cwd, baseRef: baseBranch, headRef: branch });
    return { baseBranch, branch, files };
  } catch (err) {
    throw new RunGitChangeError("获取变更失败", "GIT_DIFF_FAILED", String(err));
  }
}

export async function getRunDiff(opts: {
  prisma: PrismaDeps;
  runId: string;
  path: string;
}): Promise<{ baseBranch: string; branch: string; path: string; diff: string }> {
  const run = await opts.prisma.run.findUnique({
    where: { id: opts.runId },
    include: {
      agent: { select: { id: true, capabilities: true } } as any,
      issue: { include: { project: true, assignedAgent: { select: { id: true, capabilities: true } } } } as any,
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    throw new RunGitChangeError("Run 不存在", "NOT_FOUND");
  }

  const baseBranch = resolveBaseBranch(run);
  const branch = resolveBranch(run);
  if (!branch) {
    throw new RunGitChangeError("Run 暂无 branch 信息", "NO_BRANCH");
  }

  const cwd = typeof run.workspacePath === "string" && run.workspacePath.trim() ? run.workspacePath.trim() : process.cwd();

  try {
    if (isBoxliteGitCloneRun(run)) {
      await fetchForGitCloneBestEffort({ cwd, project: (run as any).issue.project, branches: [baseBranch, branch] });
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["diff", `origin/${baseBranch}...origin/${branch}`, "--", opts.path],
          {
            cwd,
            maxBuffer: 10 * 1024 * 1024
          },
        );
        return { baseBranch, branch, path: opts.path, diff: stdout };
      } catch {
        const { stdout } = await execFileAsync("git", ["diff", `${baseBranch}...${branch}`, "--", opts.path], {
          cwd,
          maxBuffer: 10 * 1024 * 1024
        });
        return { baseBranch, branch, path: opts.path, diff: stdout };
      }
    }

    const { stdout } = await execFileAsync("git", ["diff", `${baseBranch}...${branch}`, "--", opts.path], {
      cwd,
      maxBuffer: 10 * 1024 * 1024
    });
    return { baseBranch, branch, path: opts.path, diff: stdout };
  } catch (err) {
    throw new RunGitChangeError("获取 diff 失败", "GIT_DIFF_FAILED", String(err));
  }
}
