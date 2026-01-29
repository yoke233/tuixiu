import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { PrismaDeps } from "../../deps.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);

  const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
  const candNorm = process.platform === "win32" ? candidate.toLowerCase() : candidate;

  if (candNorm === rootNorm) return true;
  const prefix = rootNorm.endsWith(path.sep) ? rootNorm : `${rootNorm}${path.sep}`;
  return candNorm.startsWith(prefix);
}

async function cleanupCloneWorkspaces(opts: {
  prisma: PrismaDeps;
  workspacesRoot: string;
  ttlDays: number;
  log: Logger;
}): Promise<number> {
  const cutoff = new Date(Date.now() - opts.ttlDays * 24 * 60 * 60 * 1000);

  const runs = await opts.prisma.run.findMany({
    where: {
      workspaceType: "clone",
      workspacePath: { not: null },
      completedAt: { lt: cutoff },
    } as any,
    select: { id: true, workspacePath: true, completedAt: true },
    orderBy: { completedAt: "asc" },
    take: 2000,
  });

  let removed = 0;
  for (const run of runs as any[]) {
    const workspacePath = typeof run.workspacePath === "string" ? run.workspacePath.trim() : "";
    if (!workspacePath) continue;

    if (!isWithinRoot(opts.workspacesRoot, workspacePath)) {
      opts.log("skip workspace cleanup (outside root)", { runId: run.id, workspacePath });
      continue;
    }

    const base = path.basename(workspacePath);
    if (!base.startsWith("run-")) {
      opts.log("skip workspace cleanup (unexpected name)", { runId: run.id, workspacePath });
      continue;
    }

    if (path.resolve(workspacePath) === path.resolve(opts.workspacesRoot)) continue;

    try {
      await rm(workspacePath, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      opts.log("workspace cleanup failed", { runId: run.id, err: String(err) });
    }
  }

  return removed;
}

async function cleanupRepoCache(opts: {
  repoCacheRoot: string;
  ttlDays: number;
  log: Logger;
}): Promise<number> {
  const cutoffMs = Date.now() - opts.ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = (await readdir(opts.repoCacheRoot, { withFileTypes: true })) as any;
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith(".git")) continue;

    const cachePath = path.join(opts.repoCacheRoot, entry.name);
    if (!isWithinRoot(opts.repoCacheRoot, cachePath)) continue;

    try {
      const s = await stat(cachePath);
      const mtimeMs = s.mtime?.getTime?.() ?? 0;
      if (mtimeMs <= 0 || mtimeMs >= cutoffMs) continue;

      await rm(cachePath, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      opts.log("repo cache cleanup failed", { cachePath, err: String(err) });
    }
  }

  return removed;
}

export function startWorkspaceCleanupLoop(opts: {
  prisma: PrismaDeps;
  workspacesRoot: string;
  repoCacheRoot: string;
  workspaceTtlDays: number;
  repoCacheTtlDays: number;
  intervalSeconds: number;
  log: Logger;
}) {
  const intervalMs = Math.max(60, Math.floor(opts.intervalSeconds)) * 1000;

  const runOnce = async () => {
    try {
      const [workspacesRemoved, cachesRemoved] = await Promise.all([
        cleanupCloneWorkspaces({
          prisma: opts.prisma,
          workspacesRoot: opts.workspacesRoot,
          ttlDays: opts.workspaceTtlDays,
          log: opts.log,
        }),
        cleanupRepoCache({
          repoCacheRoot: opts.repoCacheRoot,
          ttlDays: opts.repoCacheTtlDays,
          log: opts.log,
        }),
      ]);

      if (workspacesRemoved || cachesRemoved) {
        opts.log("cleanup done", { workspacesRemoved, cachesRemoved });
      }
    } catch (err) {
      opts.log("cleanup loop failed", { err: String(err) });
    }
  };

  void runOnce();

  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
}

