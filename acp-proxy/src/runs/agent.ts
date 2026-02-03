import * as acp from "@agentclientprotocol/sdk";

import type { ProxyContext } from "../proxyContext.js";
import { nowIso } from "../proxyContext.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";
import { pickSecretValues, redactSecrets } from "../utils/secrets.js";
import { isRecord } from "../utils/validate.js";
import { AgentBridge } from "../acp/agentBridge.js";
import { AcpClientFacade } from "../acpClientFacade.js";
import type { JsonRpcRequest } from "../acpClientFacade.js";

import type { RunRuntime } from "./runTypes.js";
import { filterAgentInitEnv } from "./agentEnv.js";
import { defaultCwdForRun } from "./workspacePath.js";
import { parseInitStepLine } from "./init.js";
import { sendSandboxInstanceStatus, sendUpdate } from "./updates.js";

function resolveTerminalEnabled(ctx: ProxyContext): boolean {
  return ctx.cfg.sandbox.terminalEnabled === true;
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
    workspaceGuestPath: defaultCwdForRun({
      workspaceMode: ctx.cfg.sandbox.workspaceMode ?? "mount",
      runId: run.runId,
    }),
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
    init: res.initPending ? { pending: true, markerPrefix: "__ACP_PROXY_INIT_RESULT__:" } : undefined,
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

