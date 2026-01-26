import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { GitAuthMode, GitAuthProject } from "./gitAuth.js";
import { createGitProcessEnv } from "./gitAuth.js";
import { createRunWorktree, defaultRunBranchName } from "./gitWorkspace.js";

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export type WorkspaceMode = "worktree" | "clone";

export type CreateRunWorkspaceResult = {
  workspaceMode: WorkspaceMode;
  workspacePath: string;
  branchName: string;
  baseBranch: string;
  repoRoot?: string;
  repoCachePath?: string;
  gitAuthMode?: GitAuthMode;
  timingsMs: Record<string, number>;
};

export async function createRunWorkspace(opts: {
  runId: string;
  baseBranch: string;
  name: string;
  project: GitAuthProject & {
    id: string;
    workspaceMode?: string | null;
  };
  workspacesRoot: string;
  repoCacheRoot: string;
}): Promise<CreateRunWorkspaceResult> {
  const baseBranch = String(opts.baseBranch ?? "").trim() ? String(opts.baseBranch).trim() : "main";
  const branchName = defaultRunBranchName(opts.name);

  const workspaceMode: WorkspaceMode =
    String(opts.project.workspaceMode ?? "").trim().toLowerCase() === "clone" ? "clone" : "worktree";

  if (workspaceMode === "worktree") {
    const ws = await createRunWorktree({ runId: opts.runId, baseBranch, name: opts.name });
    return {
      workspaceMode,
      workspacePath: ws.workspacePath,
      branchName: ws.branchName,
      baseBranch,
      repoRoot: ws.repoRoot,
      timingsMs: {},
    };
  }

  const timingsMs: Record<string, number> = {};
  const t0 = Date.now();
  const { env, cleanup, gitAuthMode } = await createGitProcessEnv(opts.project);

  const workspacePath = path.join(opts.workspacesRoot, `run-${opts.runId}`);
  const repoCachePath = path.join(opts.repoCacheRoot, `${opts.project.id}.git`);

  await mkdir(opts.workspacesRoot, { recursive: true });
  await mkdir(opts.repoCacheRoot, { recursive: true });

  if (await pathExists(workspacePath)) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  }

  let mirrorReady = false;
  try {
    const m0 = Date.now();
    if (await pathExists(repoCachePath)) {
      await execFileAsync("git", ["-C", repoCachePath, "fetch", "--prune"], { env });
    } else {
      await execFileAsync("git", ["clone", "--mirror", opts.project.repoUrl, repoCachePath], { env });
    }
    timingsMs.mirrorMs = Date.now() - m0;
    mirrorReady = true;
  } catch {
    mirrorReady = false;
  }

  try {
    const c0 = Date.now();
    const cloneArgs = [
      "clone",
      "--branch",
      baseBranch,
      "--single-branch",
      ...(mirrorReady ? ["--reference-if-able", repoCachePath] : []),
      opts.project.repoUrl,
      workspacePath,
    ];
    await execFileAsync("git", cloneArgs, { env });
    timingsMs.cloneMs = Date.now() - c0;

    const k0 = Date.now();
    await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workspacePath, env });
    timingsMs.checkoutMs = Date.now() - k0;
  } catch (err) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await cleanup();
    timingsMs.totalMs = Date.now() - t0;
  }

  return {
    workspaceMode,
    workspacePath,
    branchName,
    baseBranch,
    repoCachePath: mirrorReady ? repoCachePath : undefined,
    gitAuthMode,
    timingsMs,
  };
}

