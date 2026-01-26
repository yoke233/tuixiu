import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps } from "../deps.js";

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
  return typeof branch === "string" ? branch : "";
}

export async function getRunChanges(opts: { prisma: PrismaDeps; runId: string }): Promise<{
  baseBranch: string;
  branch: string;
  files: RunChangeFile[];
}> {
  const run = await opts.prisma.run.findUnique({
    where: { id: opts.runId },
    include: {
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    throw new RunGitChangeError("Run 不存在", "NOT_FOUND");
  }

  const baseBranch = run.issue.project.defaultBranch || "main";
  const branch = resolveBranch(run);
  if (!branch) {
    throw new RunGitChangeError("Run 暂无 branch 信息", "NO_BRANCH");
  }

  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-status", `${baseBranch}...${branch}`], {
      cwd: process.cwd()
    });
    const files = parseNameStatus(stdout);
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
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!run) {
    throw new RunGitChangeError("Run 不存在", "NOT_FOUND");
  }

  const baseBranch = run.issue.project.defaultBranch || "main";
  const branch = resolveBranch(run);
  if (!branch) {
    throw new RunGitChangeError("Run 暂无 branch 信息", "NO_BRANCH");
  }

  try {
    const { stdout } = await execFileAsync("git", ["diff", `${baseBranch}...${branch}`, "--", opts.path], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024
    });
    return { baseBranch, branch, path: opts.path, diff: stdout };
  } catch (err) {
    throw new RunGitChangeError("获取 diff 失败", "GIT_DIFF_FAILED", String(err));
  }
}
