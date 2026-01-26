import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
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

function truncateUnicode(input: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const chars = Array.from(input);
  if (chars.length <= maxChars) return input;
  return chars.slice(0, maxChars).join("");
}

function normalizeRunKey(input: string): string {
  const raw = String(input ?? "").trim().toLowerCase();
  if (!raw) return "";

  // Windows 文件名不允许：<>:"/\|?*
  // Git 分支名不允许：空格、~ ^ : ? * [ \ 以及控制字符
  const replaced = raw
    .replaceAll(/[/\\]/g, "-")
    .replaceAll(/\s+/g, "-")
    .replaceAll(/\p{Cc}/gu, "")
    .replaceAll(/[[<>:"|?*~^\]]/g, "-");

  // 避免 git ref 禁止的片段：..、@{、.lock
  let s = replaced.replaceAll("..", "-").replaceAll("@{", "-").replaceAll(".lock", "-lock");

  s = s
    .replaceAll(/-+/g, "-")
    .replaceAll(/\.+/g, ".")
    .replaceAll(/^[.-]+/g, "")
    .replaceAll(/[.-]+$/g, "")
    .trim();

  // 兼顾 Windows：末尾不能是空格/点
  s = s.replaceAll(/[ .]+$/g, "");

  // 过长会导致 Windows 路径过长/branch 难用
  s = truncateUnicode(s, 60);

  return s;
}

export function suggestRunKey(opts: {
  title?: string | null;
  externalProvider?: string | null;
  externalNumber?: number | null;
  runNumber?: number;
}): string {
  const title = String(opts.title ?? "").trim();
  const titleKey = normalizeRunKey(title);

  const provider = String(opts.externalProvider ?? "").trim().toLowerCase();
  const externalNumber = opts.externalNumber;
  const hasExternalNumber = Number.isFinite(externalNumber) && (externalNumber ?? 0) > 0;

  let base = "";
  if (provider && hasExternalNumber) {
    const prefix = provider === "github" ? "gh" : provider;
    base = `${prefix}-${externalNumber}`;
    if (titleKey) base = `${base}-${titleKey}`;
  } else {
    base = titleKey || "run";
  }

  const runNumber = opts.runNumber;
  if (Number.isFinite(runNumber) && (runNumber ?? 0) > 0) {
    base = `${base}-r${runNumber}`;
  }

  return normalizeRunKey(base);
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

async function localBranchExists(repoRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

export function defaultRunBranchName(runKey: string): string {
  return `run/${runKey}`;
}

function defaultRunWorkspaceDirName(runKey: string): string {
  return `run-${runKey}`;
}

async function resolveUniqueRunKey(opts: {
  repoRoot: string;
  worktreesRoot: string;
  desiredKey: string;
}): Promise<string> {
  const baseKey = normalizeRunKey(opts.desiredKey);
  if (!baseKey) return "";

  for (let i = 1; i <= 50; i++) {
    const runKey = i === 1 ? baseKey : `${baseKey}-${i}`;
    const branchName = defaultRunBranchName(runKey);
    const workspacePath = path.join(opts.worktreesRoot, defaultRunWorkspaceDirName(runKey));

    if (await pathExists(workspacePath)) continue;
    if (await localBranchExists(opts.repoRoot, branchName)) continue;

    return runKey;
  }

  // 极端情况下兜底：避免卡死
  return `${baseKey}-${Date.now().toString(36)}`;
}

export async function createRunWorktree(opts: {
  runId: string;
  baseBranch: string;
  name?: string;
}): Promise<{ repoRoot: string; branchName: string; workspacePath: string }> {
  const repoRoot = await getRepoRoot();

  const worktreesRoot = path.join(repoRoot, ".worktrees");
  await mkdir(worktreesRoot, { recursive: true });

  const desiredKey = normalizeRunKey(opts.name ?? "");
  const runKey = await resolveUniqueRunKey({ repoRoot, worktreesRoot, desiredKey });
  if (!runKey) {
    throw new Error("无法生成合法的 worktree/branch 名称（worktreeName 为空或包含非法字符）");
  }

  const branchName = defaultRunBranchName(runKey);
  const workspacePath = path.join(worktreesRoot, defaultRunWorkspaceDirName(runKey));

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

