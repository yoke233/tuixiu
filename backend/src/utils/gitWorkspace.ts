import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedRepoRoot: string | null = null;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(): Promise<string> {
  if (cachedRepoRoot) return cachedRepoRoot;
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() });
  const root = String(stdout ?? "").trim();
  if (!root) {
    throw new Error("无法定位 git repo root（git rev-parse --show-toplevel 为空）");
  }
  cachedRepoRoot = root;
  return root;
}

export function defaultRunBranchName(runId: string): string {
  return `run/${runId}`;
}

export async function createRunWorktree(opts: {
  runId: string;
  baseBranch: string;
}): Promise<{ repoRoot: string; branchName: string; workspacePath: string }> {
  const repoRoot = await getRepoRoot();
  const branchName = defaultRunBranchName(opts.runId);

  const worktreesRoot = path.join(repoRoot, ".worktrees");
  const workspacePath = path.join(worktreesRoot, `run-${opts.runId}`);

  await mkdir(worktreesRoot, { recursive: true });

  if (await pathExists(workspacePath)) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], { cwd: repoRoot });
    } catch {
      // ignore
    }
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  }

  // best-effort: ensure base branch exists (or can be fetched)
  try {
    await execFileAsync("git", ["rev-parse", "--verify", opts.baseBranch], { cwd: repoRoot });
  } catch {
    try {
      await execFileAsync("git", ["fetch", "origin", opts.baseBranch], { cwd: repoRoot });
    } catch {
      // ignore; let later command surface the final error
    }
  }

  await execFileAsync("git", ["worktree", "add", "-b", branchName, workspacePath, opts.baseBranch], { cwd: repoRoot });

  return { repoRoot, branchName, workspacePath };
}

