import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";

import { AcpClientFacade } from "../acpClientFacade.js";
import type { JsonRpcRequest } from "../acpClientFacade.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";
import { DEFAULT_KEEPALIVE_TTL_SECONDS, WORKSPACE_GUEST_PATH, nowIso } from "../proxyContext.js";
import type { ProxyContext } from "../proxyContext.js";
import { pickSecretValues, redactSecrets } from "../utils/secrets.js";
import { isRecord, validateInstanceName, validateRunId } from "../utils/validate.js";
import { AgentBridge } from "../acp/agentBridge.js";

import type { RunRuntime } from "./runTypes.js";

export function sendUpdate(ctx: ProxyContext, runId: string, content: unknown): void {
  try {
    ctx.send({ type: "agent_update", run_id: runId, content });
  } catch (err) {
    ctx.log("failed to send agent_update", { runId, err: String(err) });
  }
}

export function sendSandboxInstanceStatus(
  ctx: ProxyContext,
  opts: {
    runId: string;
    instanceName: string;
    status: "creating" | "running" | "stopped" | "missing" | "error";
    lastError?: string | null;
  },
): void {
  sendUpdate(ctx, opts.runId, {
    type: "sandbox_instance_status",
    instance_name: opts.instanceName,
    provider: ctx.sandbox.provider,
    runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
    status: opts.status,
    last_seen_at: nowIso(),
    last_error: opts.lastError ?? null,
  });
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

  if (!run.acpClient) {
    run.acpClient = new AcpClientFacade({
      runId,
      instanceName,
      workspaceGuestRoot: WORKSPACE_GUEST_PATH,
      sandbox: ctx.sandbox as any,
      log: ctx.log,
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
    workspaceGuestPath: WORKSPACE_GUEST_PATH,
    env: undefined,
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

  await agent.close().catch(() => {});
  ctx.log("agent closed", { runId: run.runId, reason });
}

export async function runInitScript(
  ctx: ProxyContext,
  run: RunRuntime,
  init?: AgentInit,
): Promise<boolean> {
  const script = init?.script?.trim() ?? "";
  if (!script) return true;

  const timeoutSecondsRaw = init?.timeout_seconds ?? 300;
  const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
    ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
    : 300;

  const env = init?.env ? { ...init.env } : undefined;
  const secrets = pickSecretValues(env);
  const redact = (line: string) => redactSecrets(line, secrets);

  sendUpdate(ctx, run.runId, {
    type: "text",
    text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
  });

  const proc = await ctx.sandbox.execProcess({
    instanceName: run.instanceName,
    command: ["bash", "-lc", script],
    cwdInGuest: WORKSPACE_GUEST_PATH,
    env,
  });

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
  const initEnv: Record<string, string> | undefined =
    init?.env && typeof init.env === "object" && !Array.isArray(init.env)
      ? { ...(init.env as Record<string, string>) }
      : undefined;

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
    workspaceGuestPath: WORKSPACE_GUEST_PATH,
    agentCommand: ctx.cfg.agent_command,
    init,
  });

  const secrets: string[] = [
    ...(ctx.cfg.auth_token?.trim() ? [ctx.cfg.auth_token.trim()] : []),
    ...pickSecretValues(ctx.cfg.sandbox.env),
    ...pickSecretValues(initEnv),
  ];
  const redact = (line: string) => redactSecrets(line, secrets);

  if (!run.acpClient) {
    run.acpClient = new AcpClientFacade({
      runId: run.runId,
      instanceName: run.instanceName,
      workspaceGuestRoot: WORKSPACE_GUEST_PATH,
      sandbox: ctx.sandbox as any,
      log: ctx.log,
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
      if (msg.method === "session/update") {
        const params = msg.params;
        const sessionId =
          isRecord(params) && typeof (params as any).sessionId === "string"
            ? String((params as any).sessionId)
            : "";
        const update = isRecord(params) ? (params as any).update : undefined;

        try {
          ctx.send({
            type: "prompt_update",
            run_id: run.runId,
            prompt_id: run.activePromptId,
            session_id: sessionId || null,
            update,
          });
        } catch (err) {
          ctx.log("failed to send prompt_update", { runId: run.runId, err: String(err) });
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
      terminal: ctx.cfg.sandbox.terminalEnabled === true,
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

export async function withAuthRetry<T>(run: RunRuntime, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthRequiredError(err)) throw err;
    if (!run.agent) throw err;
    const initResult = run.initResult as any;
    const methodId = initResult?.authMethods?.[0]?.id ?? "";
    if (!methodId) throw err;
    await run.agent.sendRpc("authenticate", { methodId });
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

  const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  let prompt = opts.prompt;

  if (!run.agent) throw new Error("agent not connected");

  if (!sessionId) {
    const created = await withAuthRetry(run, () =>
      run.agent!.sendRpc<any>("session/new", { cwd: opts.cwd, mcpServers: [] }),
    );
    const createdSessionId = String((created as any)?.sessionId ?? "").trim();
    if (!createdSessionId) throw new Error("session/new 未返回 sessionId");
    run.seenSessionIds.add(createdSessionId);
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
          cwd: opts.cwd,
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
