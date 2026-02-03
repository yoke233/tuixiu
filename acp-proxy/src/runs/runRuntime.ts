import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import { AcpClientFacade } from "../acpClientFacade.js";
import type { JsonRpcRequest } from "../acpClientFacade.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";
import type { ProcessHandle } from "../sandbox/types.js";
import { DEFAULT_KEEPALIVE_TTL_SECONDS, WORKSPACE_GUEST_PATH, nowIso } from "../proxyContext.js";
import type { ProxyContext } from "../proxyContext.js";
import { pickSecretValues, redactSecrets } from "../utils/secrets.js";
import { createHostGitEnv } from "../utils/gitHost.js";
import { isRecord, validateInstanceName, validateRunId } from "../utils/validate.js";
import { AgentBridge } from "../acp/agentBridge.js";

import type { RunRuntime } from "./runTypes.js";
import { defaultCwdForRun } from "./workspacePath.js";
import { filterAgentInitEnv } from "./agentEnv.js";
import { parseAgentInputsFromInit } from "./agentInputs.js";
import { sendSandboxInstanceStatus, sendUpdate } from "./updates.js";

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

export async function closeAgent(
  ctx: ProxyContext,
  run: RunRuntime,
  reason: string,
): Promise<void> {
  const agent = run.agent;
  if (!agent) return;

  run.agent = null;
  run.initialized = false;
  run.initResult = null;
  run.seenSessionIds.clear();
  run.activePromptId = null;
  run.acpClient?.cancelAllPermissions();

  await agent.close().catch(() => {});
  ctx.log("agent closed", { runId: run.runId, reason });
}

export async function runInitScript(
  ctx: ProxyContext,
  run: RunRuntime,
  init?: AgentInit,
): Promise<boolean> {
  if (ctx.sandbox.provider === "host_process") {
    ctx.log("host_process skip init script", { runId: run.runId });
    return true;
  }

  const script = init?.script?.trim() ?? "";
  if (!script) return true;

  const timeoutSecondsRaw = init?.timeout_seconds ?? 300;
  const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
    ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
    : 300;

  const envRaw =
    init?.env && typeof init.env === "object" && !Array.isArray(init.env)
      ? { ...(init.env as Record<string, string>) }
      : undefined;
  const env = envRaw ? filterAgentInitEnv(ctx, run.runId, envRaw) : undefined;
  const secrets = pickSecretValues(env);
  const redact = (line: string) => redactSecrets(line, secrets);

  sendUpdate(ctx, run.runId, {
    type: "text",
    text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
  });

  let proc: ProcessHandle;
  try {
    proc = await ctx.sandbox.execProcess({
      instanceName: run.instanceName,
      command: ["bash", "-lc", script],
      cwdInGuest: defaultCwdForRun({ workspaceMode: ctx.cfg.sandbox.workspaceMode ?? "mount", runId: run.runId }),
      env,
    });
  } catch (err) {
    const message = String(err);
    sendUpdate(ctx, run.runId, {
      type: "init_step",
      stage: "init",
      status: "failed",
      message,
    });
    sendUpdate(ctx, run.runId, { type: "init_result", ok: false, error: message });
    return false;
  }

  const readLines = async (
    stream: ReadableStream<Uint8Array> | undefined,
    label: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n/g);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const text = redact(line);
          if (!text.trim()) continue;
          const step = parseInitStepLine(text);
          if (step) {
            sendUpdate(ctx, run.runId, { type: "init_step", ...step });
            continue;
          }
          ctx.log("init output", { runId: run.runId, stream: label, text });
          sendUpdate(ctx, run.runId, {
            type: "text",
            text: `[init:${label}] ${text}`,
          });
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      const rest = redact(buf);
      if (rest.trim()) {
        const step = parseInitStepLine(rest);
        if (step) {
          sendUpdate(ctx, run.runId, { type: "init_step", ...step });
        } else {
          ctx.log("init output", { runId: run.runId, stream: label, text: rest });
          sendUpdate(ctx, run.runId, {
            type: "text",
            text: `[init:${label}] ${rest}`,
          });
        }
      }
    }
  };

  const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.onExit?.((info: { code: number | null; signal: string | null }) => resolve(info));
    if (!proc.onExit) resolve({ code: null, signal: null });
  });
  const outP = readLines(proc.stdout, "stdout");
  const errP = readLines(proc.stderr, "stderr");

  const raced = await Promise.race([
    exitP.then((r) => ({ kind: "exit" as const, ...r })),
    delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
  ]);

  if (raced.kind === "timeout") {
    sendUpdate(ctx, run.runId, {
      type: "init_result",
      ok: false,
      error: `timeout after ${timeoutSeconds}s`,
    });
    await proc.close().catch(() => {});
    await Promise.allSettled([outP, errP]);
    return false;
  }

  await Promise.allSettled([outP, errP]);

  if (raced.code !== 0) {
    sendUpdate(ctx, run.runId, {
      type: "init_result",
      ok: false,
      exitCode: raced.code,
      error: `exitCode=${raced.code}`,
    });
    return false;
  }

  sendUpdate(ctx, run.runId, { type: "init_result", ok: true });
  sendUpdate(ctx, run.runId, { type: "text", text: "[init] done" });
  return true;
}

export async function startAgent(
  ctx: ProxyContext,
  run: RunRuntime,
  init?: AgentInit,
): Promise<void> {
  if (run.agent) return;

  const initScript = init?.script?.trim() ?? "";
  const timeoutSecondsRaw = init?.timeout_seconds ?? 300;
  const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
    ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
    : 300;
  const initEnvRaw =
    init?.env && typeof init.env === "object" && !Array.isArray(init.env)
      ? { ...(init.env as Record<string, string>) }
      : undefined;
  const initEnv = initEnvRaw ? filterAgentInitEnv(ctx, run.runId, initEnvRaw) : undefined;
  const effectiveInit = initEnv ? ({ ...(init ?? {}), env: initEnv } as AgentInit) : init;

  if (ctx.sandbox.agentMode === "entrypoint") {
    const before = await ctx.sandbox.inspectInstance(run.instanceName);
    const willRecreate = !!initScript && before.status !== "missing";
    if (before.status === "missing" || willRecreate) {
      sendSandboxInstanceStatus(ctx, {
        runId: run.runId,
        instanceName: run.instanceName,
        status: "creating",
        lastError: null,
      });
    }
    if (initScript) {
      sendUpdate(ctx, run.runId, {
        type: "text",
        text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
      });
    }
  }

  const res = await ctx.sandbox.openAgent({
    runId: run.runId,
    instanceName: run.instanceName,
    workspaceGuestPath: defaultCwdForRun({ workspaceMode: ctx.cfg.sandbox.workspaceMode ?? "mount", runId: run.runId }),
    mounts: run.workspaceMounts,
    agentCommand: ctx.cfg.agent_command,
    init: effectiveInit,
  });

  const secrets: string[] = [
    ...(ctx.cfg.auth_token?.trim() ? [ctx.cfg.auth_token.trim()] : []),
    ...pickSecretValues(ctx.cfg.sandbox.env),
    ...pickSecretValues(initEnv),
  ];
  const redact = (line: string) => redactSecrets(line, secrets);

  if (!run.acpClient) {
    const permissionAsk = ctx.sandbox.provider === "host_process";
    run.acpClient = new AcpClientFacade({
      runId: run.runId,
      instanceName: run.instanceName,
      workspaceGuestRoot: defaultCwdForRun({
        workspaceMode: ctx.cfg.sandbox.workspaceMode ?? "mount",
        runId: run.runId,
      }),
      workspaceHostRoot: run.hostWorkspacePath,
      sandbox: ctx.sandbox as any,
      log: ctx.log,
      terminalEnabled: resolveTerminalEnabled(ctx),
      permissionAsk,
      onPermissionRequest: (req) => {
        sendUpdate(ctx, run.runId, {
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

  if (ctx.sandbox.agentMode === "entrypoint" && res.initPending) {
    run.suppressNextAcpExit = true;
  }

  const bridge = new AgentBridge({
    handle: res.handle,
    init: res.initPending
      ? { pending: true, markerPrefix: "__ACP_PROXY_INIT_RESULT__:" }
      : undefined,
    redactLine: redact,
    onRequest: async (req: JsonRpcRequest) => {
      run.lastUsedAt = Date.now();
      return (await run.acpClient!.handleRequest(req)) as any;
    },
    onNotification: (msg) => {
      run.lastUsedAt = Date.now();
      if (msg.method === "$/cancel_request") {
        const params = msg.params;
        const requestId = isRecord(params) ? (params as any).requestId : null;
        if (requestId != null) {
          const cancelled = run.acpClient?.cancelPermissionRequest(requestId);
          if (!cancelled) {
            ctx.log("cancel_request ignored (not found)", {
              runId: run.runId,
              requestId: String(requestId),
            });
          }
        }
        return;
      }

      if (msg.method === "session/update") {
        const params = msg.params;
        const sessionId =
          isRecord(params) && typeof (params as any).sessionId === "string"
            ? String((params as any).sessionId)
            : "";
        const update = isRecord(params) ? (params as any).update : undefined;

        try {
          ctx.send({
            type: "acp_update",
            run_id: run.runId,
            prompt_id: run.activePromptId,
            session_id: sessionId || null,
            update,
          });
        } catch (err) {
          ctx.log("failed to send acp_update", { runId: run.runId, err: String(err) });
        }

        // 自动把 codex-acp 的 Approval Preset 从 read-only 切到 auto（如果 Agent 提供了该 configOption）。
        // 注意：这里只在 host_process 下做（也就是本机运行 Agent 时），并且对每个 sessionId 只执行一次。
        if (
          ctx.sandbox.provider === "host_process" &&
          sessionId &&
          isRecord(update) &&
          (update as any).sessionUpdate === "config_option_update"
        ) {
          const configOptions = Array.isArray((update as any).configOptions)
            ? ((update as any).configOptions as any[])
            : null;
          const modeOpt = configOptions?.find(
            (x) => x && typeof x === "object" && (x as any).id === "mode",
          ) as any;
          const currentValue = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : "";
          const options = Array.isArray(modeOpt?.options) ? (modeOpt.options as any[]) : null;
          const hasAuto = !!options?.some(
            (o) => o && typeof o === "object" && (o as any).value === "auto",
          );

          if (hasAuto && currentValue && currentValue !== "auto") {
            if (!run.autoConfigOptionAppliedSessionIds) {
              run.autoConfigOptionAppliedSessionIds = new Set();
            }
            if (!run.autoConfigOptionAppliedSessionIds.has(sessionId)) {
              run.autoConfigOptionAppliedSessionIds.add(sessionId);
              void withAuthRetry(run, () =>
                run.agent!.sendRpc<any>("session/set_config_option", {
                  sessionId,
                  configId: "mode",
                  value: "auto",
                }),
              ).catch((err) => {
                ctx.log("auto set_config_option(mode=auto) failed", {
                  runId: run.runId,
                  sessionId,
                  err: String(err),
                });
              });
            }
          }
        }
      } else {
        ctx.log("jsonrpc notification (unhandled)", { runId: run.runId, method: msg.method });
      }
    },
    onStderrLine: (line, kind) => {
      if (kind === "init") {
        const step = parseInitStepLine(line);
        if (step) {
          sendUpdate(ctx, run.runId, { type: "init_step", ...step });
          return;
        }
        sendUpdate(ctx, run.runId, { type: "text", text: `[init:stderr] ${line}` });
        return;
      }
      ctx.log("agent stderr", { runId: run.runId, text: line });
      sendUpdate(ctx, run.runId, { type: "text", text: `[agent:stderr] ${line}` });
    },
    onExit: (info) => {
      if (run.suppressNextAcpExit) {
        run.suppressNextAcpExit = false;
        return;
      }
      ctx.log("agent exited", {
        runId: run.runId,
        instanceName: run.instanceName,
        code: info.code,
        signal: info.signal,
      });
      sendUpdate(ctx, run.runId, {
        type: "transport_disconnected",
        instance_name: run.instanceName,
        code: info.code ?? null,
        signal: info.signal ?? null,
        at: nowIso(),
        reason: "agent_exit",
      });
      void closeAgent(ctx, run, "agent_exit").finally(() => {
        try {
          ctx.send({
            type: "acp_exit",
            run_id: run.runId,
            instance_name: run.instanceName,
            code: info.code,
            signal: info.signal,
          });
        } catch {
          // ignore
        }
      });
    },
  });

  run.agent = bridge;
  sendUpdate(ctx, run.runId, {
    type: "transport_connected",
    instance_name: run.instanceName,
    at: nowIso(),
  });

  const info = await ctx.sandbox.inspectInstance(run.instanceName);
  sendSandboxInstanceStatus(ctx, {
    runId: run.runId,
    instanceName: run.instanceName,
    status: info.status === "missing" ? "missing" : info.status,
    lastError: null,
  });

  if (ctx.sandbox.agentMode === "entrypoint" && res.initPending) {
    let initResult: { ok: boolean; exitCode: number | null };
    try {
      initResult = await bridge.waitForInitResult({ timeoutMs: timeoutSeconds * 1000 });
    } catch (err) {
      sendUpdate(ctx, run.runId, { type: "init_result", ok: false, error: String(err) });
      await closeAgent(ctx, run, "init_failed");
      await ctx.sandbox.stopInstance(run.instanceName).catch(() => {});
      throw err;
    }

    if (!initResult.ok) {
      const exitCode = typeof initResult.exitCode === "number" ? initResult.exitCode : null;
      sendUpdate(ctx, run.runId, {
        type: "init_result",
        ok: false,
        exitCode,
        error: exitCode != null ? `exitCode=${exitCode}` : "init_failed",
      });
      await closeAgent(ctx, run, "init_failed");
      await ctx.sandbox.stopInstance(run.instanceName).catch(() => {});
      throw new Error(exitCode != null ? `init exitCode=${exitCode}` : "init failed");
    }

    run.suppressNextAcpExit = false;
    sendUpdate(ctx, run.runId, { type: "init_result", ok: true });
    sendUpdate(ctx, run.runId, { type: "text", text: "[init] done" });
  }
}

export async function ensureInitialized(ctx: ProxyContext, run: RunRuntime): Promise<unknown> {
  if (run.initialized && run.initResult) return run.initResult;
  if (!run.agent) throw new Error("agent not connected");

  const raw = (acp as any).PROTOCOL_VERSION;
  const protocolVersion =
    typeof raw === "number" ? raw : Number.isFinite(Number(raw)) ? Number(raw) : 1;

  const initResult = await run.agent.sendRpc("initialize", {
    protocolVersion,
    clientInfo: { name: "acp-proxy", title: "tuixiu acp-proxy", version: "0.0.0" },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: resolveTerminalEnabled(ctx),
    },
  });

  run.initialized = true;
  run.initResult = initResult;
  return initResult;
}

function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).code === -32000;
}

function authTimeoutMsFromEnv(): number {
  const raw = Number(process.env.ACP_PROXY_AUTH_TIMEOUT_MS ?? "30000");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(300_000, Math.max(5_000, Math.floor(raw)));
  }
  return 30_000;
}

export async function withAuthRetry<T>(run: RunRuntime, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthRequiredError(err)) throw err;
    if (!run.agent) throw err;
    const initResult = run.initResult as any;
    const methodId = initResult?.authMethods?.[0]?.id ?? "";
    if (!methodId) throw err;
    await run.agent.sendRpc("authenticate", { methodId }, { timeoutMs: authTimeoutMsFromEnv() });
    return await fn();
  }
}

type PromptCapabilities = { image?: boolean; audio?: boolean; embeddedContext?: boolean };

export function getPromptCapabilities(initResult: unknown | null): PromptCapabilities {
  const caps = isRecord(initResult)
    ? (initResult as any).agentCapabilities?.promptCapabilities
    : null;
  return isRecord(caps) ? (caps as PromptCapabilities) : {};
}

const INIT_STEP_PREFIX = "__TUIXIU_INIT_STEP__:";

function parseInitStepLine(
  line: string,
): { stage: string; status: string; message?: string } | null {
  if (!line.startsWith(INIT_STEP_PREFIX)) return null;
  const raw = line.slice(INIT_STEP_PREFIX.length).trim();
  if (!raw) return null;
  const parts = raw.split(":");
  const stage = parts[0]?.trim();
  const status = parts[1]?.trim() || "progress";
  const message = parts.slice(2).join(":").trim();
  if (!stage) return null;
  return message ? { stage, status, message } : { stage, status };
}

export function assertPromptBlocksSupported(
  prompt: readonly any[],
  promptCapabilities: PromptCapabilities,
): void {
  for (const block of prompt) {
    const type = block?.type;
    switch (type) {
      case "text":
      case "resource_link":
        break;
      case "image":
        if (!promptCapabilities.image) {
          throw new Error("Agent 未启用 promptCapabilities.image，无法发送 image 类型内容");
        }
        break;
      case "audio":
        if (!promptCapabilities.audio) {
          throw new Error("Agent 未启用 promptCapabilities.audio，无法发送 audio 类型内容");
        }
        break;
      case "resource":
        if (!promptCapabilities.embeddedContext) {
          throw new Error(
            "Agent 未启用 promptCapabilities.embeddedContext，无法发送 resource(embedded) 类型内容",
          );
        }
        break;
      default:
        throw new Error(`未知的 ACP content block type: ${String(type)}`);
    }
  }
}

export function composePromptWithContext(
  context: string | undefined,
  prompt: any[],
  promptCapabilities: PromptCapabilities,
): any[] {
  const ctx = context?.trim();
  if (!ctx) return prompt;

  const prelude = [
    "你正在接手一个可能因为进程重启导致 ACP session 丢失的任务。",
    "下面是系统保存的上下文（Issue 信息 + 最近对话节选）。请先阅读、恢复当前进度，然后继续响应用户的新消息。",
    "",
    "=== 上下文开始 ===",
  ].join("\n");
  const suffix = ["=== 上下文结束 ===", "", "用户消息："].join("\n");

  if (promptCapabilities.embeddedContext) {
    return [
      { type: "text", text: prelude },
      {
        type: "resource",
        resource: { uri: "tuixiu://context", mimeType: "text/markdown", text: ctx },
      },
      { type: "text", text: suffix },
      ...prompt,
    ];
  }

  return [{ type: "text", text: [prelude, ctx, suffix].join("\n") }, ...prompt];
}

export async function ensureSessionForPrompt(
  ctx: ProxyContext,
  run: RunRuntime,
  opts: { cwd: string; sessionId?: string | null; context?: string; prompt: any[] },
): Promise<{ sessionId: string; prompt: any[]; created: boolean }> {
  const initResult = await ensureInitialized(ctx, run);
  const promptCapabilities = getPromptCapabilities(initResult);

  const cwd = ctx.platform.resolveCwdForAgent({
    cwd: opts.cwd,
    runHostWorkspacePath: run.hostWorkspacePath ?? null,
  });

  const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  let prompt = opts.prompt;

  if (!run.agent) throw new Error("agent not connected");

  if (!sessionId) {
    const created = await withAuthRetry(run, () =>
      run.agent!.sendRpc<any>("session/new", { cwd, mcpServers: [] }),
    );
    const createdSessionId = String((created as any)?.sessionId ?? "").trim();
    if (!createdSessionId) throw new Error("session/new 未返回 sessionId");
    run.seenSessionIds.add(createdSessionId);

    // session/new 的返回里通常包含 configOptions，但不一定会立刻触发 session/update 通知。
    // 为了让后端/前端能在“第一条对话输出之前”就知道可配置项，这里把它作为一条合成的 config_option_update 上报。
    try {
      ctx.send({
        type: "acp_update",
        run_id: run.runId,
        prompt_id: run.activePromptId ?? null,
        session_id: createdSessionId,
        update: { sessionUpdate: "session_created", content: { type: "session_created" } },
      });
    } catch (err) {
      ctx.log("failed to send synthetic session_created", {
        runId: run.runId,
        sessionId: createdSessionId,
        err: String(err),
      });
    }
    const configOptions = Array.isArray((created as any)?.configOptions)
      ? ((created as any).configOptions as any[])
      : null;
    if (configOptions) {
      try {
        ctx.send({
          type: "acp_update",
          run_id: run.runId,
          prompt_id: run.activePromptId ?? null,
          session_id: createdSessionId,
          update: { sessionUpdate: "config_option_update", configOptions },
        });
      } catch (err) {
        ctx.log("failed to send synthetic config_option_update", {
          runId: run.runId,
          sessionId: createdSessionId,
          err: String(err),
        });
      }
    }

    try {
      await ctx.platform.onSessionCreated?.({
        run,
        sessionId: createdSessionId,
        createdMeta: created,
      });
    } catch (err) {
      ctx.log("platform.onSessionCreated failed", {
        runId: run.runId,
        sessionId: createdSessionId,
        err: String(err),
      });
    }
    prompt = composePromptWithContext(opts.context, prompt, promptCapabilities);
    return { sessionId: createdSessionId, prompt, created: true };
  }

  if (!run.seenSessionIds.has(sessionId)) {
    run.seenSessionIds.add(sessionId);
    const canLoad = !!(initResult as any)?.agentCapabilities?.loadSession;
    if (canLoad) {
      await withAuthRetry(run, () =>
        run.agent!.sendRpc<any>("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        }),
      ).catch((err) => {
        ctx.log("session/load failed", { runId: run.runId, err: String(err) });
      });
    }
  }

  return { sessionId, prompt, created: false };
}

export function shouldRecreateSession(err: unknown): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("session") || msg.includes("sessionid");
}
