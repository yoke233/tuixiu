import { access, mkdir, rm, writeFile, rename, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProxyContext } from "../proxyContext.js";
import type { RunRuntime } from "./runTypes.js";
import type { AgentInputItem, AgentInputsManifest, AgentInputsTargetRoot } from "./agentInputs.js";
import { extractZipSafe } from "../skills/zipSafeExtract.js";
import { downloadToFile } from "../skills/httpDownload.js";
import { ensureHasSkillMd } from "../skills/contentHash.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function httpBaseFromOrchestratorUrl(orchestratorUrl: string): string {
  const url = new URL(orchestratorUrl);
  const proto = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  return `${proto}//${url.host}`;
}

function isSubPath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveHostRoot(run: RunRuntime, root: AgentInputsTargetRoot): string {
  if (root === "WORKSPACE") {
    const host = run.hostWorkspacePath?.trim() ?? "";
    if (!host) throw new Error("hostWorkspacePath missing");
    return host;
  }
  const host = run.hostUserHomePath?.trim() ?? "";
  if (!host) throw new Error("hostUserHomePath missing");
  return host;
}

function resolveHostTargetPath(hostRoot: string, relPosix: string): string {
  const normalized = String(relPosix ?? "").replaceAll("\\", "/").trim();
  const parts = normalized ? normalized.split("/").filter(Boolean) : [];
  const resolved = path.resolve(hostRoot, ...parts);
  if (!isSubPath(hostRoot, resolved)) {
    throw new Error("target escaped host root");
  }
  return resolved;
}

async function applyDownloadExtract(opts: {
  ctx: ProxyContext;
  run: RunRuntime;
  item: AgentInputItem;
  targetDir: string;
}): Promise<void> {
  if (opts.item.source.type !== "httpZip") {
    throw new Error(`downloadExtract requires source=httpZip (item=${opts.item.id})`);
  }

  const base = httpBaseFromOrchestratorUrl(opts.ctx.cfg.orchestrator_url);
  const url = new URL(opts.item.source.uri, base).toString();
  const auth = opts.ctx.cfg.auth_token?.trim() ?? "";
  const headers = auth ? { authorization: `Bearer ${auth}` } : undefined;

  const cacheRoot = path.join(os.homedir(), ".tuixiu", "acp-proxy", "inputs-cache");
  const zipsDir = path.join(cacheRoot, "zips");
  await mkdir(zipsDir, { recursive: true });

  const contentHash = opts.item.source.contentHash?.trim() ?? "";
  const zipFile = contentHash ? path.join(zipsDir, `${contentHash}.zip`) : path.join(zipsDir, `${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);

  if (!(await pathExists(zipFile))) {
    opts.ctx.log("agentInputs download start", { runId: opts.run.runId, itemId: opts.item.id, url });
    await downloadToFile({
      url,
      destFile: zipFile,
      headers,
      timeoutMs: 60_000,
      maxBytes: opts.ctx.cfg.skills_download_max_bytes,
    });
    opts.ctx.log("agentInputs download done", { runId: opts.run.runId, itemId: opts.item.id, zipFile });
  }

  const tmpExtract = `${opts.targetDir}.tmp-${Math.random().toString(16).slice(2)}`;
  await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
  await mkdir(tmpExtract, { recursive: true });

  try {
    await extractZipSafe({ zipFile, outDir: tmpExtract });

    // 如果看起来是在落 skills（~/.codex/skills/<name>），做一个最小完整性检查：必须包含 SKILL.md。
    const targetNorm = opts.item.target.path.replaceAll("\\", "/");
    if (opts.item.target.root === "USER_HOME" && targetNorm.includes(".codex/skills")) {
      await ensureHasSkillMd(tmpExtract);
    }

    await rm(opts.targetDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(path.dirname(opts.targetDir), { recursive: true });

    try {
      await rename(tmpExtract, opts.targetDir);
    } catch {
      await cp(tmpExtract, opts.targetDir, { recursive: true, force: true });
      await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    opts.ctx.log("agentInputs downloadExtract failed", { runId: opts.run.runId, itemId: opts.item.id, err: String(err) });
    await rm(tmpExtract, { recursive: true, force: true }).catch(() => {});
    if (!contentHash) await rm(zipFile, { force: true }).catch(() => {});
    throw err;
  }
}

async function applyWriteFile(opts: { item: AgentInputItem; filePath: string }): Promise<void> {
  if (opts.item.source.type !== "inlineText") {
    throw new Error(`writeFile requires source=inlineText (item=${opts.item.id})`);
  }
  await mkdir(path.dirname(opts.filePath), { recursive: true });
  await writeFile(opts.filePath, opts.item.source.text, "utf8");
}

export async function applyAgentInputs(opts: {
  ctx: ProxyContext;
  run: RunRuntime;
  manifest: AgentInputsManifest;
}): Promise<void> {
  for (const item of opts.manifest.items) {
    opts.ctx.log("agentInputs apply start", {
      runId: opts.run.runId,
      itemId: item.id,
      apply: item.apply,
      targetRoot: item.target.root,
      targetPath: item.target.path,
    });
    const hostRoot = resolveHostRoot(opts.run, item.target.root);
    const hostTarget = resolveHostTargetPath(hostRoot, item.target.path);

    if (item.apply === "bindMount") {
      // bindMount 由 ensureRuntime 负责转换为 mounts，并在 ensureInstanceRunning/openAgent 时生效。
      opts.ctx.log("agentInputs apply done", { runId: opts.run.runId, itemId: item.id, skipped: "bindMount" });
      continue;
    }

    if (item.apply === "copy") {
      if (item.source.type !== "hostPath") {
        throw new Error(`copy requires source=hostPath (item=${item.id})`);
      }
      const from = path.resolve(item.source.path);
      await mkdir(path.dirname(hostTarget), { recursive: true });
      await rm(hostTarget, { recursive: true, force: true }).catch(() => {});
      await cp(from, hostTarget, { recursive: true, force: true });
      opts.ctx.log("agentInputs apply done", { runId: opts.run.runId, itemId: item.id });
      continue;
    }

    if (item.apply === "downloadExtract") {
      await applyDownloadExtract({ ctx: opts.ctx, run: opts.run, item, targetDir: hostTarget });
      opts.ctx.log("agentInputs apply done", { runId: opts.run.runId, itemId: item.id });
      continue;
    }

    if (item.apply === "writeFile") {
      await applyWriteFile({ item, filePath: hostTarget });
      opts.ctx.log("agentInputs apply done", { runId: opts.run.runId, itemId: item.id });
      continue;
    }

    throw new Error(`unsupported apply method: ${item.apply}`);
  }
}
