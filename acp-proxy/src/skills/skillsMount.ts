import { access, chmod, cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProxyContext } from "../proxyContext.js";
import { WORKSPACE_GUEST_PATH } from "../proxyContext.js";
import type { RunRuntime } from "../runs/runTypes.js";

import { computeContentHashFromDir, ensureHasSkillMd } from "./contentHash.js";
import { downloadToFile } from "./httpDownload.js";
import { parseSkillsManifest } from "./parseSkillsManifest.js";
import type { SkillsManifest } from "./skillsTypes.js";
import { extractZipSafe } from "./zipSafeExtract.js";

type Semaphore = { run: <T>(fn: () => Promise<T>) => Promise<T> };
function createSemaphore(limit: number): Semaphore {
  const effectiveLimit = Math.max(1, Math.floor(limit || 1));
  let inUse = 0;
  const queue: Array<() => void> = [];
  const acquire = async () => {
    if (inUse < effectiveLimit) {
      inUse += 1;
      return;
    }
    await new Promise<void>((resolve) => queue.push(resolve));
    inUse += 1;
  };
  const release = () => {
    inUse = Math.max(0, inUse - 1);
    const next = queue.shift();
    if (next) next();
  };
  return {
    run: async <T>(fn: () => Promise<T>) => {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function kebabCase(value: string): string {
  const out = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return out;
}

function httpBaseFromOrchestratorUrl(orchestratorUrl: string): string {
  const url = new URL(orchestratorUrl);
  const proto = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  return `${proto}//${url.host}`;
}

function resolveCacheRoot(): string {
  return path.join(os.homedir(), ".tuixiu", "acp-proxy", "skills-cache");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const ensureExtractedLocks = new Map<string, Promise<string>>();
const downloadSemaphore = createSemaphore(3);

async function setTreeMode(opts: { rootDir: string; modeDir: number; modeFile: number }): Promise<void> {
  const rootDir = path.resolve(opts.rootDir);
  const entries = await readdir(rootDir, { withFileTypes: true });

  await chmod(rootDir, opts.modeDir).catch(() => {});

  for (const ent of entries) {
    const p = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      await setTreeMode({ rootDir: p, modeDir: opts.modeDir, modeFile: opts.modeFile });
      continue;
    }
    if (!ent.isFile()) continue;
    await chmod(p, opts.modeFile).catch(() => {});
  }
}

async function ensureExtractedInternal(opts: {
  ctx: ProxyContext;
  contentHash: string;
  storageUri: string;
}): Promise<string> {
  const cacheRoot = resolveCacheRoot();
  const zipDir = path.join(cacheRoot, "zips");
  const extractedRoot = path.join(cacheRoot, "extracted");
  await mkdir(zipDir, { recursive: true });
  await mkdir(extractedRoot, { recursive: true });

  const zipFile = path.join(zipDir, `${opts.contentHash}.zip`);
  const extractedDir = path.join(extractedRoot, opts.contentHash);
  const markerFile = path.join(extractedDir, ".validated.json");

  if (await pathExists(markerFile)) {
    opts.ctx.log("skills cache hit", { contentHash: opts.contentHash });
    return extractedDir;
  }

  if (!(await pathExists(zipFile))) {
    const base = httpBaseFromOrchestratorUrl(opts.ctx.cfg.orchestrator_url);
    const url = new URL(opts.storageUri, base).toString();
    const auth = opts.ctx.cfg.auth_token?.trim() ?? "";
    const headers = auth ? { authorization: `Bearer ${auth}` } : undefined;

    await downloadSemaphore.run(async () => {
      const attempts = 3;
      for (let attempt = 1; attempt <= attempts; attempt++) {
          const startedAt = Date.now();
          try {
            opts.ctx.log("skills download start", { contentHash: opts.contentHash, url, attempt });
            const res = await downloadToFile({
              url,
              destFile: zipFile,
              headers,
              timeoutMs: 60_000,
              maxBytes: opts.ctx.cfg.skills_download_max_bytes,
            });
            opts.ctx.log("skills download done", {
              contentHash: opts.contentHash,
              attempt,
              bytes: res.bytes,
              ms: Date.now() - startedAt,
          });
          return;
        } catch (err) {
          opts.ctx.log("skills download failed", {
            contentHash: opts.contentHash,
            attempt,
            err: String(err),
          });
          if (attempt >= attempts) throw err;
          await sleep(400 * attempt);
        }
      }
    });
  } else {
    opts.ctx.log("skills zip cache hit", { contentHash: opts.contentHash });
  }

  const tmpExtract = path.join(
    extractedRoot,
    `${opts.contentHash}.tmp-${Math.random().toString(16).slice(2)}`,
  );
  await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
  await mkdir(tmpExtract, { recursive: true });

  const extractStartedAt = Date.now();
  try {
    await extractZipSafe({ zipFile, outDir: tmpExtract });
    await ensureHasSkillMd(tmpExtract);

    const hashed = await computeContentHashFromDir(tmpExtract);
    if (hashed.contentHash !== opts.contentHash) {
      throw new Error(
        `skills package contentHash mismatch: expected=${opts.contentHash} actual=${hashed.contentHash}`,
      );
    }

    await rm(extractedDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.dirname(extractedDir), { recursive: true });
    // Prefer rename (atomic) when possible.
    try {
      await rename(tmpExtract, extractedDir);
    } catch {
      // Fallback: copy.
      await cp(tmpExtract, extractedDir, { recursive: true, force: true });
      await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    }

    await writeFile(
      markerFile,
      JSON.stringify({ contentHash: opts.contentHash, validatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );

    opts.ctx.log("skills extract+validate done", {
      contentHash: opts.contentHash,
      ms: Date.now() - extractStartedAt,
    });

    return extractedDir;
  } catch (err) {
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    await rm(zipFile, { force: true }).catch(() => {});
    opts.ctx.log("skills extract+validate failed", { contentHash: opts.contentHash, err: String(err) });
    throw err;
  }
}

async function ensureExtracted(opts: {
  ctx: ProxyContext;
  contentHash: string;
  storageUri: string;
}): Promise<string> {
  const existing = ensureExtractedLocks.get(opts.contentHash);
  if (existing) return await existing;

  const promise = ensureExtractedInternal(opts).finally(() => {
    ensureExtractedLocks.delete(opts.contentHash);
  });
  ensureExtractedLocks.set(opts.contentHash, promise);
  return await promise;
}

export function parseSkillsManifestFromInit(init: unknown): SkillsManifest | null {
  if (!init || typeof init !== "object" || Array.isArray(init)) return null;
  if (!("skillsManifest" in (init as any))) return null;
  const manifest = (init as any).skillsManifest ?? null;
  if (!manifest) return null;
  const parsed = parseSkillsManifest(manifest);
  if (!parsed) throw new Error("INVALID_SKILLS_MANIFEST");
  return parsed;
}

export async function prepareSkillsForRun(opts: {
  ctx: ProxyContext;
  run: RunRuntime;
  init: unknown;
}): Promise<{ codexHomeGuestPath: string; codexHomeHostPath: string } | null> {
  if (!opts.ctx.cfg.skills_mounting_enabled) return null;

  const manifest = parseSkillsManifestFromInit(opts.init);
  if (!manifest) return null;
  if (manifest.runId !== opts.run.runId) {
    throw new Error(`skillsManifest.runId mismatch: ${manifest.runId} != ${opts.run.runId}`);
  }
  if (!manifest.skillVersions.length) return null;

  const workspaceMode = opts.ctx.cfg.sandbox.workspaceMode ?? "mount";
  if (workspaceMode !== "mount") {
    throw new Error(`skills mounting requires sandbox.workspaceMode=mount (got ${workspaceMode})`);
  }

  const hostWorkspacePath = opts.run.hostWorkspacePath?.trim() ?? "";
  if (!hostWorkspacePath) {
    throw new Error("skills mounting requires hostWorkspacePath");
  }

  const codexHomeHostPath = path.join(hostWorkspacePath, ".tuixiu", "codex-home");
  const codexHomeGuestPath =
    opts.ctx.sandbox.provider === "host_process"
      ? codexHomeHostPath
      : `${WORKSPACE_GUEST_PATH}/.tuixiu/codex-home`;
  const skillsHostRoot = path.join(codexHomeHostPath, "skills");

  const mountStartedAt = Date.now();
  opts.ctx.log("skills mounting start", { runId: opts.run.runId, count: manifest.skillVersions.length });

  await mkdir(skillsHostRoot, { recursive: true });

  const usedNames = new Set<string>();
  for (const sv of manifest.skillVersions) {
    const extractedDir = await ensureExtracted({
      ctx: opts.ctx,
      contentHash: sv.contentHash,
      storageUri: sv.storageUri,
    });

    let dirName = kebabCase(sv.skillName);
    if (!dirName) dirName = `skill-${sv.skillId.slice(0, 8)}`;
    if (usedNames.has(dirName)) {
      dirName = `${dirName}-${sv.contentHash.slice(0, 8)}`;
    }
    usedNames.add(dirName);

    const destDir = path.join(skillsHostRoot, dirName);
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.dirname(destDir), { recursive: true });
    await cp(extractedDir, destDir, { recursive: true, force: true });
    await ensureHasSkillMd(destDir);
    // Best-effort read-only view (avoid agent mutating skill content).
    await setTreeMode({ rootDir: destDir, modeDir: 0o555, modeFile: 0o444 }).catch(() => {});
  }

  opts.ctx.log("skills mounting done", {
    runId: opts.run.runId,
    count: manifest.skillVersions.length,
    ms: Date.now() - mountStartedAt,
  });

  return { codexHomeGuestPath, codexHomeHostPath };
}

export async function cleanupSkillsForRun(run: RunRuntime): Promise<void> {
  const codexHomeHostPath = (run as any).skillsCodexHomeHostPath as string | undefined;
  if (!codexHomeHostPath?.trim()) return;
  await setTreeMode({ rootDir: codexHomeHostPath, modeDir: 0o755, modeFile: 0o644 }).catch(() => {});
  await rm(codexHomeHostPath, { recursive: true, force: true }).catch(() => {});
}
