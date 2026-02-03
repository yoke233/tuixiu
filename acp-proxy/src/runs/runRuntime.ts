import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { AcpClientFacade } from "../acpClientFacade.js";
import { DEFAULT_KEEPALIVE_TTL_SECONDS, WORKSPACE_GUEST_PATH } from "../proxyContext.js";
import type { ProxyContext } from "../proxyContext.js";
import { createHostGitEnv } from "../utils/gitHost.js";
import { isRecord, validateInstanceName, validateRunId } from "../utils/validate.js";

import type { RunRuntime } from "./runTypes.js";
import { defaultCwdForRun } from "./workspacePath.js";
import { parseAgentInputsFromInit } from "./agentInputs.js";
import { sendSandboxInstanceStatus, sendUpdate } from "./updates.js";

export { closeAgent, ensureInitialized, startAgent, withAuthRetry } from "./agent.js";
export { runInitScript } from "./init.js";
export { sendSandboxInstanceStatus, sendUpdate } from "./updates.js";

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveTerminalEnabled(ctx: ProxyContext): boolean {
  return ctx.cfg.sandbox.terminalEnabled === true;
}

function normalizeAbsolutePosixPath(p: string): string {
  const raw = String(p ?? "").replaceAll("\\", "/").trim();
  if (!raw) throw new Error("path empty");
  if (!raw.startsWith("/")) throw new Error("path must be absolute (posix)");
  if (raw.split("/").some((seg) => seg === "..")) throw new Error("path must not include '..'");
  const normalized = path.posix.normalize(raw);
  if (!normalized.startsWith("/")) throw new Error("path must be absolute (posix)");
  return normalized;
}

export async function ensureRuntime(ctx: ProxyContext, msg: any): Promise<RunRuntime> {
  const runId = validateRunId(msg?.run_id);
  const instanceName =
    typeof msg?.instance_name === "string" && msg.instance_name.trim()
      ? validateInstanceName(msg.instance_name)
      : validateInstanceName(`tuixiu-run-${runId}`);

  const keepaliveTtlRaw = msg?.keepalive_ttl_seconds ?? null;
  const keepaliveTtlSeconds = Number.isFinite(keepaliveTtlRaw as number)
    ? Math.max(60, Math.min(24 * 3600, Number(keepaliveTtlRaw)))
    : DEFAULT_KEEPALIVE_TTL_SECONDS;

  const run = ctx.runs.getOrCreate({ runId, instanceName, keepaliveTtlSeconds });
  run.keepaliveTtlSeconds = keepaliveTtlSeconds;
  run.expiresAt = null;
  run.lastUsedAt = Date.now();

  const init = isRecord(msg?.init) ? (msg.init as any) : undefined;
  const initEnv =
    init?.env && typeof init.env === "object" && !Array.isArray(init.env)
      ? (init.env as Record<string, string>)
      : undefined;
  const agentInputs = parseAgentInputsFromInit(init);

  const workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount";
  const workspaceGuestRoot = defaultCwdForRun({ workspaceMode, runId });
  if (workspaceMode === "mount") {
    const rootRaw = ctx.cfg.sandbox.workspaceHostRoot?.trim() ?? "";
    if (!rootRaw) {
      throw new Error("sandbox.workspaceHostRoot 未配置，无法使用 mount 模式");
    }
    const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);

    const agentInputsWorkspaceBind = (() => {
      if (!agentInputs) return "";
      for (const item of agentInputs.items) {
        if (item.apply !== "bindMount") continue;
        if (item.source.type !== "hostPath") continue;
        if (item.target.root !== "WORKSPACE") continue;
        const targetPath = String(item.target.path ?? "").replaceAll("\\", "/").trim();
        if (targetPath && targetPath !== ".") continue;
        return String(item.source.path ?? "").trim();
      }
      return "";
    })();

    // 兼容旧链路：如果仍提供了 TUIXIU_WORKSPACE，则作为兜底提示。
    // 新推荐：由 agentInputs 中 WORKSPACE bindMount 的 hostPath 决定。
    const hintedWorkspace = initEnv ? String(initEnv.TUIXIU_WORKSPACE ?? "").trim() : "";

    const candidate = (() => {
      if (agentInputsWorkspaceBind && path.isAbsolute(agentInputsWorkspaceBind)) return agentInputsWorkspaceBind;
      if (hintedWorkspace && path.isAbsolute(hintedWorkspace)) return hintedWorkspace;
      return path.join(root, `run-${runId}`);
    })();
    const hostWorkspacePath = path.resolve(candidate);
    const rootResolved = path.resolve(root);
    const rel = path.relative(rootResolved, hostWorkspacePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      if (agentInputsWorkspaceBind) {
        throw new Error("agentInputs WORKSPACE bindMount hostPath must be under sandbox.workspaceHostRoot");
      }
      throw new Error("TUIXIU_WORKSPACE must be under sandbox.workspaceHostRoot");
    }

    await mkdir(hostWorkspacePath, { recursive: true });
    run.hostWorkspacePath = hostWorkspacePath;
    run.hostWorkspaceReady = false;

    const userHomeGuestPathHint =
      initEnv && (String(initEnv.USER_HOME ?? "").trim() || String(initEnv.HOME ?? "").trim())
        ? String(initEnv.USER_HOME ?? initEnv.HOME ?? "").trim()
        : "/root";
    const userHomeGuestPath = normalizeAbsolutePosixPath(userHomeGuestPathHint);
    const wsRootNorm = normalizeAbsolutePosixPath(WORKSPACE_GUEST_PATH);
    if (
      userHomeGuestPath === wsRootNorm ||
      userHomeGuestPath.startsWith(wsRootNorm.endsWith("/") ? wsRootNorm : `${wsRootNorm}/`)
    ) {
      throw new Error("USER_HOME/HOME must not be /workspace or inside /workspace");
    }
    const hostUserHomePath = path.resolve(path.join(rootResolved, `home-${runId}`));
    const homeRel = path.relative(rootResolved, hostUserHomePath);
    if (homeRel.startsWith("..") || path.isAbsolute(homeRel)) {
      throw new Error("resolved hostUserHomePath outside sandbox.workspaceHostRoot");
    }
    await mkdir(hostUserHomePath, { recursive: true });
    await mkdir(path.join(hostUserHomePath, ".codex", "skills"), { recursive: true });

    run.hostUserHomePath = hostUserHomePath;
    run.userHomeGuestPath = userHomeGuestPath;

    run.workspaceMounts = [
      { hostPath: hostWorkspacePath, guestPath: WORKSPACE_GUEST_PATH },
      { hostPath: hostUserHomePath, guestPath: userHomeGuestPath },
    ];
  } else {
    run.hostWorkspacePath = null;
    run.hostWorkspaceReady = false;
    run.workspaceMounts = undefined;
    run.hostUserHomePath = null;
    run.userHomeGuestPath = null;
  }

  if (!run.acpClient) {
    const permissionAsk = ctx.sandbox.provider === "host_process";
    run.acpClient = new AcpClientFacade({
      runId,
      instanceName,
      workspaceGuestRoot,
      workspaceHostRoot: run.hostWorkspacePath,
      sandbox: ctx.sandbox as any,
      log: ctx.log,
      terminalEnabled: resolveTerminalEnabled(ctx),
      permissionAsk,
      onPermissionRequest: (req) => {
        sendUpdate(ctx, runId, {
          type: "permission_request",
          request_id: req.requestId,
          session_id: req.sessionId,
          prompt_id: run.activePromptId ?? null,
          tool_call: req.toolCall,
          options: req.options,
        });
      },
    });
  }

  if (ctx.sandbox.agentMode === "entrypoint") {
    const info = await ctx.sandbox.inspectInstance(instanceName);
    sendSandboxInstanceStatus(ctx, {
      runId,
      instanceName,
      status: info.status === "missing" ? "missing" : info.status,
      lastError: null,
    });
    return run;
  }

  const info = await ctx.sandbox.ensureInstanceRunning({
    runId,
    instanceName,
    workspaceGuestPath: workspaceGuestRoot,
    env: undefined,
    mounts: run.workspaceMounts,
  });
  sendSandboxInstanceStatus(ctx, {
    runId,
    instanceName,
    status: info.status === "missing" ? "missing" : info.status,
    lastError: null,
  });
  if (info.status !== "running") {
    throw new Error(`sandbox 实例未处于 running 状态：${info.status}`);
  }
  return run;
}

export async function ensureHostWorkspaceGit(
  ctx: ProxyContext,
  run: RunRuntime,
  initEnv?: Record<string, string>,
): Promise<void> {
  const workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount";
  if (workspaceMode !== "mount") return;

  const hostWorkspacePath = run.hostWorkspacePath?.trim() ?? "";
  if (!hostWorkspacePath) {
    throw new Error("hostWorkspacePath 缺失，无法准备宿主机 workspace");
  }

  const env = initEnv ?? {};
  const repo = String(env.TUIXIU_REPO_URL ?? "").trim();
  const branch = String(env.TUIXIU_RUN_BRANCH ?? "").trim();
  const baseBranch = String(env.TUIXIU_BASE_BRANCH ?? "main").trim() || "main";

  if (!repo) throw new Error("缺少 TUIXIU_REPO_URL，无法准备宿主机 workspace");
  if (!branch) throw new Error("缺少 TUIXIU_RUN_BRANCH，无法准备宿主机 workspace");

  const gitDir = path.join(hostWorkspacePath, ".git");
  const reportStep = (stage: string, status: string, message?: string) => {
    sendUpdate(ctx, run.runId, {
      type: "init_step",
      stage,
      status,
      ...(message ? { message } : {}),
    });
  };

  let cleanup = async () => {};
  try {
    reportStep("auth", "start");
    const hostEnvRes = await createHostGitEnv(env);
    cleanup = hostEnvRes.cleanup;
    const hostEnv = hostEnvRes.env;
    reportStep("auth", "done");

    reportStep("clone", "start");
    if (await pathExists(gitDir)) {
      await execFileAsync("git", ["-C", hostWorkspacePath, "fetch", "--prune"], { env: hostEnv });
    } else {
      await rm(hostWorkspacePath, { recursive: true, force: true }).catch(() => {});
      await mkdir(hostWorkspacePath, { recursive: true });
      await execFileAsync(
        "git",
        ["clone", "--branch", baseBranch, "--single-branch", repo, hostWorkspacePath],
        { env: hostEnv },
      );
    }
    reportStep("clone", "done");

    reportStep("checkout", "start");
    try {
      await execFileAsync("git", ["-C", hostWorkspacePath, "checkout", "-B", branch, `origin/${baseBranch}`], {
        env: hostEnv,
      });
    } catch {
      await execFileAsync("git", ["-C", hostWorkspacePath, "checkout", "-B", branch], { env: hostEnv });
    }
    reportStep("checkout", "done");
    reportStep("ready", "done");
    run.hostWorkspaceReady = true;
  } catch (err) {
    reportStep("init", "failed", String(err));
    throw err;
  } finally {
    await cleanup().catch(() => {});
  }
}
