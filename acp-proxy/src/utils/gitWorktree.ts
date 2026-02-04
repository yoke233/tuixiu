import path from "node:path";

export function parseGitDirFromWorktree(content: string): string | null {
  const trimmed = String(content ?? "").trim();
  if (!trimmed.startsWith("gitdir:")) return null;
  const raw = trimmed.slice("gitdir:".length).trim();
  if (!raw) return null;
  return path.normalize(raw);
}

export function resolveBaseRepoFromGitDir(gitDir: string): string | null {
  if (!gitDir) return null;
  return path.resolve(gitDir, "..", "..", "..");
}
