import crypto from "node:crypto";
import path from "node:path";

export function hashRepoUrl(repoUrl: string): string {
  return crypto.createHash("sha1").update(repoUrl).digest("hex");
}

export function resolveRepoCacheDir(workspaceHostRoot: string, repoUrl: string): string {
  const cacheRoot = path.join(workspaceHostRoot, "_repo-cache");
  return path.join(cacheRoot, hashRepoUrl(repoUrl));
}

export function resolveRepoLockPath(workspaceHostRoot: string, repoUrl: string): string {
  const cacheRoot = path.join(workspaceHostRoot, "_repo-cache");
  const lockRoot = path.join(cacheRoot, "_locks");
  return path.join(lockRoot, `${hashRepoUrl(repoUrl)}.lock`);
}
