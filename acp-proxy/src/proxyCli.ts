import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";
import WebSocket from "ws";

import { AcpClientFacade, type JsonRpcRequest } from "./acpClientFacade.js";
import { loadConfig } from "./config.js";
import type { IncomingMessage } from "./types.js";
import type { SandboxInstanceProvider } from "./sandbox/types.js";
import { BoxliteSandbox } from "./sandbox/boxliteSandbox.js";
import { ContainerSandbox } from "./sandbox/containerSandbox.js";
import { createLogger, type LoggerFn } from "./logger.js";

function pickArg(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nowIso(): string {
  return new Date().toISOString();
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function pickSecretValues(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const secretKeys = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
  ];
  const out: string[] = [];
  for (const k of secretKeys) {
    const v = env[k];
    if (typeof v === "string" && v.trim().length >= 6) out.push(v.trim());
  }
  return out;
}

function isJsonRpcMessage(v: unknown): v is { jsonrpc: "2.0" } {
  return isRecord(v) && v.jsonrpc === "2.0";
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    isRecord(v) &&
    v.jsonrpc === "2.0" &&
    typeof v.method === "string" &&
    (typeof (v as any).id === "string" || typeof (v as any).id === "number")
  );
}

type JsonRpcError = { code: number; message: string; data?: unknown };

function isJsonRpcResponse(v: unknown): v is {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
} {
  if (!isRecord(v) || v.jsonrpc !== "2.0") return false;
  const id = (v as any).id;
  if (!(typeof id === "string" || typeof id === "number")) return false;
  return "result" in v || "error" in v;
}

function isJsonRpcNotification(v: unknown): v is {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
} {
  if (!isRecord(v) || v.jsonrpc !== "2.0") return false;
  if (typeof (v as any).method !== "string") return false;
  const id = (v as any).id;
  return id === undefined || id === null;
}

function validateRunId(v: unknown): string {
  const runId = String(v ?? "").trim();
  if (!runId) throw new Error("run_id 为空");
  if (runId.length > 200) throw new Error("run_id 过长");
  if (/[\\/]/.test(runId)) throw new Error("run_id 不能包含路径分隔符");
  if (runId.includes(":")) throw new Error("run_id 不能包含 ':'");
  return runId;
}

function validateInstanceName(v: unknown): string {
  const name = String(v ?? "").trim();
  if (!name) throw new Error("instance_name 为空");
  if (name.length > 200) throw new Error("instance_name 过长");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error("instance_name 含非法字符");
  }
  return name;
}

const WORKSPACE_GUEST_PATH = "/workspace";
const DEFAULT_KEEPALIVE_TTL_SECONDS = 1800;

type AgentStreamState = {
  stream: ReturnType<typeof acp.ndJsonStream>;
  reader: ReadableStreamDefaultReader<acp.AnyMessage>;
  writeQueue: Promise<void>;
  close: () => Promise<void>;
};

type RunRuntime = {
  runId: string;
  instanceName: string;
  keepaliveTtlSeconds: number;
  expiresAt: number | null;
  agent: AgentStreamState | null;
  suppressNextAcpExit: boolean;
  lastUsedAt: number;
  acpClient: AcpClientFacade;
  nextRpcId: number;
  pendingRpc: Map<string | number, { resolve: (v: unknown) => void; reject: (err: unknown) => void }>;
  initialized: boolean;
  initResult: unknown | null;
  seenSessionIds: Set<string>;
  opQueue: Promise<void>;
  activePromptId: string | null;
};

export async function runProxyCli() {
  const configPath =
    pickArg(process.argv.slice(2), "--config") ??
    (existsSync("config.toml") ? "config.toml" : "config.json");
  const profile = pickArg(process.argv.slice(2), "--profile") ?? null;
  const cfg = await loadConfig(configPath, { profile: profile ?? undefined });

  const logger = createLogger();
  const log: LoggerFn = (msg, extra) => {
    if (extra) logger.info(extra, msg);
    else logger.info(msg);
  };

  const isWsl =
    process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const sandbox: SandboxInstanceProvider =
    cfg.sandbox.provider === "container_oci"
      ? new ContainerSandbox({
          log,
          config: {
            image: cfg.sandbox.image,
            runtime: cfg.sandbox.runtime ?? "docker",
            extraRunArgs: cfg.sandbox.extraRunArgs,
            workingDir: cfg.sandbox.workingDir,
            volumes: cfg.sandbox.volumes,
            env: cfg.sandbox.env,
            cpus: cfg.sandbox.cpus,
            memoryMib: cfg.sandbox.memoryMib,
          },
        })
      : new BoxliteSandbox({
          log,
          config: {
            image: cfg.sandbox.image,
            workingDir: cfg.sandbox.workingDir,
            volumes: cfg.sandbox.volumes,
            env: cfg.sandbox.env,
            cpus: cfg.sandbox.cpus,
            memoryMib: cfg.sandbox.memoryMib,
          },
        });

  const runs = new Map<string, RunRuntime>();

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    try {
      send({ type: "agent_update", run_id: runId, content });
    } catch (err) {
      log("failed to send agent_update", { runId, err: String(err) });
    }
  };

  const sendSandboxInstanceStatus = (opts: {
    runId: string;
    instanceName: string;
    status: "creating" | "running" | "stopped" | "missing" | "error";
    lastError?: string | null;
  }) => {
    sendUpdate(opts.runId, {
      type: "sandbox_instance_status",
      instance_name: opts.instanceName,
      provider: sandbox.provider,
      runtime: sandbox.provider === "container_oci" ? (sandbox.runtime ?? null) : null,
      status: opts.status,
      last_seen_at: nowIso(),
      last_error: opts.lastError ?? null,
    });
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox) ? baseCaps.sandbox : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime) ? baseCaps.runtime : {};

    const runtime: Record<string, unknown> = {
      ...baseRuntime,
      platform: process.platform,
      arch: process.arch,
      isWsl,
      wslDistro: process.env.WSL_DISTRO_NAME ?? null,
    };

    const sandboxCaps: Record<string, unknown> = {
      ...baseSandbox,
      provider: cfg.sandbox.provider,
      terminalEnabled: cfg.sandbox.terminalEnabled,
      agentMode: cfg.sandbox.provider === "container_oci" ? "entrypoint" : "exec",
      image: cfg.sandbox.image ?? null,
      workingDir: cfg.sandbox.workingDir ?? null,
    };
    if (cfg.sandbox.provider === "container_oci")
      sandboxCaps.runtime = cfg.sandbox.runtime ?? "docker";
    if (cfg.sandbox.provider === "boxlite_oci")
      sandboxCaps.workspaceMode = cfg.sandbox.workspaceMode ?? "mount";

    send({
      type: "register_agent",
      agent: {
        id: cfg.agent.id,
        name: cfg.agent.name ?? cfg.agent.id,
        max_concurrent: cfg.agent.max_concurrent,
        capabilities: {
          ...baseCaps,
          runtime,
          sandbox: sandboxCaps,
          acpTunnel: true,
        },
      },
    });
  };

  const closeAgent = async (run: RunRuntime, reason: string) => {
    const agent = run.agent;
    if (!agent) return;

    const entrypointMode = sandbox.provider === "container_oci";
    if (entrypointMode && reason !== "agent_exit") {
      run.suppressNextAcpExit = true;
    }

    run.agent = null;
    run.initialized = false;
    run.initResult = null;
    run.seenSessionIds.clear();
    run.activePromptId = null;
    run.nextRpcId = 1;
    const pendingError = new Error(`agent closed: ${reason}`);
    for (const pending of run.pendingRpc.values()) {
      try {
        pending.reject(pendingError);
      } catch {
        // ignore
      }
    }
    run.pendingRpc.clear();
    await agent.close().catch(() => {});
    log("agent closed", { runId: run.runId, reason });
  };

  const writeToAgent = async (run: RunRuntime, message: acp.AnyMessage) => {
    const agent = run.agent;
    if (!agent) throw new Error("agent not connected");
    agent.writeQueue = agent.writeQueue
      .then(async () => {
        const writer = agent.stream.writable.getWriter();
        try {
          await writer.write(message as any);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((err) => {
        log("acp write failed", { runId: run.runId, err: String(err) });
      });
    await agent.writeQueue;
  };

  const enqueueRunOp = <T>(run: RunRuntime, task: () => Promise<T>): Promise<T> => {
    const next = run.opQueue.then(task, task);
    run.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const toRpcError = (payload: unknown): (Error & { code?: number; data?: unknown }) => {
    if (payload instanceof Error) return payload as any;
    if (payload && typeof payload === "object") {
      const code = (payload as any).code;
      const message = (payload as any).message;
      const data = (payload as any).data;
      const err = new Error(typeof message === "string" ? message : String(payload)) as any;
      if (typeof code === "number") err.code = code;
      if (data !== undefined) err.data = data;
      return err;
    }
    return new Error(String(payload)) as any;
  };

  const sendRpc = async <T>(
    run: RunRuntime,
    method: string,
    params: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> => {
    const id = run.nextRpcId++;
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 300_000;

    const promise = new Promise<unknown>((resolve, reject) => {
      run.pendingRpc.set(id, { resolve, reject });
    });

    await writeToAgent(run, { jsonrpc: "2.0", id, method, params } as any);

    return (await Promise.race([
      promise,
      delay(timeoutMs).then(() => {
        run.pendingRpc.delete(id);
        throw new Error(`rpc timeout after ${timeoutMs}ms: ${method}`);
      }),
    ])) as T;
  };

  const isAuthRequiredError = (err: unknown): boolean => {
    if (!err || typeof err !== "object") return false;
    return (err as any).code === -32000;
  };

  const shouldRecreateSession = (err: unknown): boolean => {
    const msg = String(err ?? "").toLowerCase();
    return msg.includes("session") || msg.includes("sessionid");
  };

  const withAuthRetry = async <T>(run: RunRuntime, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      const initResult = run.initResult as any;
      const methodId = initResult?.authMethods?.[0]?.id ?? "";
      if (!methodId) throw err;
      await sendRpc(run, "authenticate", { methodId });
      return await fn();
    }
  };

  type PromptCapabilities = { image?: boolean; audio?: boolean; embeddedContext?: boolean };

  const getPromptCapabilities = (initResult: unknown | null): PromptCapabilities => {
    const caps = isRecord(initResult) ? (initResult as any).agentCapabilities?.promptCapabilities : null;
    return isRecord(caps) ? (caps as PromptCapabilities) : {};
  };

  const assertPromptBlocksSupported = (
    prompt: readonly any[],
    promptCapabilities: PromptCapabilities,
  ) => {
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
  };

  const composePromptWithContext = (
    context: string | undefined,
    prompt: any[],
    promptCapabilities: PromptCapabilities,
  ): any[] => {
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
  };

  const ensureInitialized = async (run: RunRuntime): Promise<unknown> => {
    if (run.initialized && run.initResult) return run.initResult;

    const raw = (acp as any).PROTOCOL_VERSION;
    const protocolVersion =
      typeof raw === "number" ? raw : Number.isFinite(Number(raw)) ? Number(raw) : 1;

    const initResult = await sendRpc(run, "initialize", {
      protocolVersion,
      clientInfo: { name: "acp-proxy", title: "tuixiu acp-proxy", version: "0.0.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: cfg.sandbox.terminalEnabled === true,
      },
    });

    run.initialized = true;
    run.initResult = initResult;
    return initResult;
  };

  const ensureSessionForPrompt = async (run: RunRuntime, opts: {
    cwd: string;
    sessionId?: string | null;
    context?: string;
    prompt: any[];
  }): Promise<{ sessionId: string; prompt: any[]; created: boolean }> => {
    const initResult = await ensureInitialized(run);
    const promptCapabilities = getPromptCapabilities(initResult);

    let sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    let prompt = opts.prompt;

    if (!sessionId) {
      const created = await withAuthRetry(run, () =>
        sendRpc<any>(run, "session/new", { cwd: opts.cwd, mcpServers: [] }),
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
          sendRpc<any>(run, "session/load", {
            sessionId,
            cwd: opts.cwd,
            mcpServers: [],
          }),
        ).catch((err) => {
          log("session/load failed", { runId: run.runId, err: String(err) });
        });
      }
    }

    return { sessionId, prompt, created: false };
  };

  const startAgent = async (
    run: RunRuntime,
    init?: {
      script?: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    },
  ) => {
    if (run.agent) return;
    const entrypointMode = sandbox.provider === "container_oci";

    const initScript = init?.script?.trim() ?? "";
    const timeoutSecondsRaw = init?.timeout_seconds ?? 300;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
      : 300;
    const initEnv: Record<string, string> | undefined =
      init?.env && typeof init.env === "object" && !Array.isArray(init.env)
        ? { ...(init.env as Record<string, string>) }
        : undefined;

    const initMarkerPrefix = "__ACP_PROXY_INIT_RESULT__:";
    const initScriptGuestPath = "/tmp/acp-proxy-init.sh";
    const initEnvGuestPath = "/tmp/acp-proxy-init-env.sh";
    const wrapperScriptGuestPath = "/tmp/acp-proxy-wrapper.sh";

    const bashAnsiCString = (value: string): string => {
      let out = "$'";
      for (const ch of value) {
        if (ch === "\\") {
          out += "\\\\";
          continue;
        }
        if (ch === "'") {
          out += "\\'";
          continue;
        }
        if (ch === "\n") {
          out += "\\n";
          continue;
        }
        if (ch === "\r") {
          out += "\\r";
          continue;
        }
        if (ch === "\t") {
          out += "\\t";
          continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          out += `\\x${code.toString(16).padStart(2, "0")}`;
          continue;
        }
        out += ch;
      }
      out += "'";
      return out;
    };

    const renderInitEnvScript = (env: Record<string, string>): string => {
      const lines: string[] = [];
      for (const [key, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        lines.push(`export ${key}=${bashAnsiCString(String(value ?? ""))}`);
      }
      return lines.join("\n");
    };

    type InitResult = {
      ok: boolean;
      exitCode?: number | null;
      skipped?: boolean;
    };

    let handle: Awaited<ReturnType<typeof sandbox.execProcess>>;
    let initPending = false;
    let initDeferred: {
      promise: Promise<InitResult>;
      resolve: (v: InitResult) => void;
      reject: (err: unknown) => void;
    } | null = null;

    if (!entrypointMode) {
      try {
        handle = await sandbox.execProcess({
          instanceName: run.instanceName,
          command: cfg.agent_command,
          cwdInGuest: WORKSPACE_GUEST_PATH,
          env: undefined,
        });
      } catch (err) {
        log("start agent failed", { runId: run.runId, err: String(err) });
        throw err;
      }
    } else {
      const containerSandbox = sandbox as unknown as ContainerSandbox;
      let before = await containerSandbox.inspectInstance(run.instanceName);

      // entrypoint 模式下：只要 acp_open 带 init.script，就必须确保 init 在 agent(PID1) 之前运行；
      // 因此需要一个“全新容器实例”来执行 init 并最终 exec agent。
      if (initScript && before.status !== "missing") {
        await containerSandbox.removeInstance(run.instanceName).catch(() => {});
        before = {
          instanceName: run.instanceName,
          status: "missing",
          createdAt: null,
        };
      }

      if (before.status !== "missing") {
        const labels = await containerSandbox.getInstanceLabels(run.instanceName);
        const agentModeLabel = labels["acp-proxy.agent_mode"] ?? "";
        if (agentModeLabel && agentModeLabel !== "entrypoint") {
          throw new Error(
            `发现既有容器但不是 entrypoint 模式（acp-proxy.agent_mode=${JSON.stringify(agentModeLabel)}）。请先 remove sandbox 实例（instance_name=${run.instanceName}）后重试。`,
          );
        }
      }

      const wrapperScript = [
        "set -euo pipefail",
        `workspace="${WORKSPACE_GUEST_PATH}"`,
        'mkdir -p "$workspace" >/dev/null 2>&1 || true',
        `init_script="${initScriptGuestPath}"`,
        `init_env="${initEnvGuestPath}"`,
        `marker="${initMarkerPrefix}"`,
        "",
        'if [ -s "$init_script" ]; then',
        '  if [ -s "$init_env" ]; then',
        '    source "$init_env"',
        "  fi",
        "  set +e",
        '  bash "$init_script" 1>&2',
        "  code=$?",
        "  set -e",
        "  if [ $code -ne 0 ]; then",
        '    printf \'%s{"ok":false,"exitCode":%s}\\n\' "$marker" "$code" >&2',
        "    exit $code",
        "  fi",
        '  printf \'%s{"ok":true}\\n\' "$marker" >&2',
        '  rm -f "$init_script" "$init_env" >/dev/null 2>&1 || true',
        "else",
        '  printf \'%s{"ok":true,"skipped":true}\\n\' "$marker" >&2',
        "fi",
        "",
        'exec "$@"',
      ].join("\n");

      const command = initScript
        ? ["bash", wrapperScriptGuestPath, ...cfg.agent_command]
        : cfg.agent_command;

      const created = before.status === "missing";

      if (before.status === "missing") {
        sendSandboxInstanceStatus({
          runId: run.runId,
          instanceName: run.instanceName,
          status: "creating",
          lastError: null,
        });

        try {
          await containerSandbox.createInstance({
            runId: run.runId,
            instanceName: run.instanceName,
            workspaceGuestPath: WORKSPACE_GUEST_PATH,
            env: undefined,
            command,
            openStdin: true,
          });

          if (initScript) {
            sendUpdate(run.runId, {
              type: "text",
              text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
            });

            const tmp = await mkdtemp(path.join(tmpdir(), "acp-proxy-init-"));
            try {
              const wrapperPath = path.join(tmp, "wrapper.sh");
              await writeFile(wrapperPath, `${wrapperScript}\n`, "utf8");
              await containerSandbox.copyToInstance({
                instanceName: run.instanceName,
                hostPath: wrapperPath,
                guestPath: wrapperScriptGuestPath,
              });

              const scriptPath = path.join(tmp, "init.sh");
              await writeFile(scriptPath, initScript, "utf8");
              await containerSandbox.copyToInstance({
                instanceName: run.instanceName,
                hostPath: scriptPath,
                guestPath: initScriptGuestPath,
              });

              if (initEnv && Object.keys(initEnv).length) {
                const envScript = renderInitEnvScript(initEnv);
                if (envScript.trim()) {
                  const envPath = path.join(tmp, "init-env.sh");
                  await writeFile(envPath, `${envScript}\n`, "utf8");
                  await containerSandbox.copyToInstance({
                    instanceName: run.instanceName,
                    hostPath: envPath,
                    guestPath: initEnvGuestPath,
                  });
                }
              }
            } finally {
              await rm(tmp, { recursive: true, force: true }).catch(() => {});
            }
          }
        } catch (err) {
          await containerSandbox.removeInstance(run.instanceName).catch(() => {});
          throw err;
        }
      }

      const connectWithRetry = async () => {
        let lastErr: unknown = null;
        for (let i = 0; i < 30; i++) {
          try {
            if (created || before.status === "stopped") {
              return await containerSandbox.startAndAttachInstance(run.instanceName);
            }
            return await containerSandbox.attachInstance(run.instanceName);
          } catch (err) {
            lastErr = err;
            await delay(200);
          }
        }
        throw lastErr ?? new Error("container attach failed");
      };

      try {
        handle = (await connectWithRetry()) as any;
      } catch (err) {
        log("start agent failed (attach)", {
          runId: run.runId,
          err: String(err),
        });
        throw err;
      }

      const info = await containerSandbox.inspectInstance(run.instanceName);
      sendSandboxInstanceStatus({
        runId: run.runId,
        instanceName: run.instanceName,
        status: info.status === "missing" ? "missing" : info.status,
        lastError: null,
      });

      initPending = created && !!initScript;
      if (!initPending && info.status !== "running") {
        throw new Error(`sandbox 实例未处于 running 状态：${info.status}`);
      }
      if (initPending) {
        run.suppressNextAcpExit = true;
        let resolve!: (v: InitResult) => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<InitResult>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        initDeferred = { promise, resolve, reject };
      }
    }

    const stream = acp.ndJsonStream(handle.stdin, handle.stdout);
    const reader = stream.readable.getReader();
    const agent: AgentStreamState = {
      stream,
      reader,
      writeQueue: Promise.resolve(),
      close: handle.close,
    };
    run.agent = agent;

    handle.onExit?.((info) => {
      if (run.suppressNextAcpExit) {
        run.suppressNextAcpExit = false;
        return;
      }
      log("agent exited", {
        runId: run.runId,
        instanceName: run.instanceName,
        code: info.code,
        signal: info.signal,
      });
      void closeAgent(run, "agent_exit").finally(() => {
        try {
          send({
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
    });

    void (async () => {
      const secrets: string[] = [
        ...(cfg.auth_token?.trim() ? [cfg.auth_token.trim()] : []),
        ...pickSecretValues(cfg.sandbox.env),
        ...pickSecretValues(initEnv),
      ];
      const redact = (line: string) => redactSecrets(line, secrets);

      const stderr = handle.stderr;
      if (!stderr) {
        initDeferred?.reject(new Error("stderr not available"));
        return;
      }

      const decoder = new TextDecoder();
      const stderrReader = stderr.getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await stderrReader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split(/\r?\n/g);
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const text = redact(line);
            if (!text.trim()) continue;
            if (!initPending && text.startsWith(initMarkerPrefix)) continue;

            if (initPending) {
              if (text.startsWith(initMarkerPrefix)) {
                const payloadRaw = text.slice(initMarkerPrefix.length).trim();
                try {
                  const parsed = JSON.parse(payloadRaw) as any;
                  const ok = !!parsed?.ok;
                  const exitCode = typeof parsed?.exitCode === "number" ? parsed.exitCode : null;
                  initDeferred?.resolve({ ok, exitCode });
                  initPending = false;
                  if (ok) run.suppressNextAcpExit = false;
                } catch (err) {
                  initDeferred?.reject(
                    new Error(
                      `init marker JSON parse failed: ${String(err)}; payload=${JSON.stringify(payloadRaw)}`,
                    ),
                  );
                  initPending = false;
                }
                continue;
              }

              sendUpdate(run.runId, {
                type: "text",
                text: `[init:stderr] ${text}`,
              });
              continue;
            }

            log("agent stderr", { runId: run.runId, text });
            sendUpdate(run.runId, {
              type: "text",
              text: `[agent:stderr] ${text}`,
            });
          }
        }
      } catch (err) {
        log("agent stderr read failed", { runId: run.runId, err: String(err) });
        initDeferred?.reject(err);
      } finally {
        try {
          stderrReader.releaseLock();
        } catch {}
        const rest = redact(buf);
        if (rest.trim()) {
          if (!initPending && rest.startsWith(initMarkerPrefix)) return;
          if (initPending && rest.startsWith(initMarkerPrefix)) {
            const payloadRaw = rest.slice(initMarkerPrefix.length).trim();
            try {
              const parsed = JSON.parse(payloadRaw) as any;
              const ok = !!parsed?.ok;
              const exitCode = typeof parsed?.exitCode === "number" ? parsed.exitCode : null;
              initDeferred?.resolve({ ok, exitCode });
              if (ok) run.suppressNextAcpExit = false;
            } catch (err) {
              initDeferred?.reject(
                new Error(
                  `init marker JSON parse failed: ${String(err)}; payload=${JSON.stringify(payloadRaw)}`,
                ),
              );
            } finally {
              initPending = false;
            }
          } else if (initPending) {
            sendUpdate(run.runId, {
              type: "text",
              text: `[init:stderr] ${rest}`,
            });
          } else {
            log("agent stderr", { runId: run.runId, text: rest });
            sendUpdate(run.runId, {
              type: "text",
              text: `[agent:stderr] ${rest}`,
            });
          }
        }
      }
    })();

    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          run.lastUsedAt = Date.now();

          if (isJsonRpcRequest(value)) {
            const res = await run.acpClient.handleRequest(value);
            if (res) {
              await writeToAgent(run, res as any);
              continue;
            }
          }

          if (isJsonRpcResponse(value)) {
            const pending = run.pendingRpc.get(value.id);
            if (pending) {
              run.pendingRpc.delete(value.id);
              if (value.error) pending.reject(toRpcError(value.error));
              else pending.resolve((value as any).result);
            } else {
              log("unexpected jsonrpc response", { runId: run.runId, id: value.id });
            }
            continue;
          }

          if (isJsonRpcNotification(value)) {
            if (value.method === "session/update") {
              const params = value.params;
              const sessionId =
                isRecord(params) && typeof (params as any).sessionId === "string"
                  ? String((params as any).sessionId)
                  : "";
              const update = isRecord(params) ? (params as any).update : undefined;

              try {
                send({
                  type: "prompt_update",
                  run_id: run.runId,
                  prompt_id: run.activePromptId,
                  session_id: sessionId || null,
                  update,
                });
              } catch (err) {
                log("failed to send prompt_update", { runId: run.runId, err: String(err) });
              }
            } else {
              log("jsonrpc notification (unhandled)", {
                runId: run.runId,
                method: value.method,
              });
            }
            continue;
          }

          log("agent stdout message ignored", { runId: run.runId });
        }
      } catch (err) {
        log("acp stream read failed", { runId: run.runId, err: String(err) });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    })();

    if (initDeferred) {
      let raced: InitResult | { timeout: true };
      try {
        raced = await Promise.race([
          initDeferred.promise,
          delay(timeoutSeconds * 1000).then(() => ({ timeout: true as const })),
        ]);
      } catch (err) {
        sendUpdate(run.runId, {
          type: "init_result",
          ok: false,
          error: String(err),
        });
        await closeAgent(run, "init_failed");
        await sandbox.stopInstance(run.instanceName).catch(() => {});
        throw err;
      }

      if ("timeout" in raced) {
        sendUpdate(run.runId, {
          type: "init_result",
          ok: false,
          error: `timeout after ${timeoutSeconds}s`,
        });
        await closeAgent(run, "init_timeout");
        await sandbox.stopInstance(run.instanceName).catch(() => {});
        throw new Error(`init timeout after ${timeoutSeconds}s`);
      }

      if (!raced.ok) {
        const exitCode = typeof raced.exitCode === "number" ? raced.exitCode : null;
        sendUpdate(run.runId, {
          type: "init_result",
          ok: false,
          exitCode,
          error: exitCode != null ? `exitCode=${exitCode}` : "init_failed",
        });
        await closeAgent(run, "init_failed");
        await sandbox.stopInstance(run.instanceName).catch(() => {});
        throw new Error(exitCode != null ? `init exitCode=${exitCode}` : "init failed");
      }

      sendUpdate(run.runId, { type: "init_result", ok: true });
      sendUpdate(run.runId, { type: "text", text: "[init] done" });
    }
  };

  const ensureRuntime = async (msg: any): Promise<RunRuntime> => {
    const runId = validateRunId(msg.run_id);
    const instanceName =
      typeof msg.instance_name === "string" && msg.instance_name.trim()
        ? validateInstanceName(msg.instance_name)
        : validateInstanceName(`tuixiu-run-${runId}`);

    const keepaliveTtlRaw = msg.keepalive_ttl_seconds ?? null;
    const keepaliveTtlSeconds = Number.isFinite(keepaliveTtlRaw as number)
      ? Math.max(60, Math.min(24 * 3600, Number(keepaliveTtlRaw)))
      : DEFAULT_KEEPALIVE_TTL_SECONDS;

    const existing = runs.get(runId) ?? null;
    if (existing && existing.instanceName !== instanceName) {
      throw new Error("instance_name 与既有运行时不一致");
    }

    const run: RunRuntime =
      existing ??
      ({
        runId,
        instanceName,
        keepaliveTtlSeconds,
        expiresAt: null,
        agent: null,
        suppressNextAcpExit: false,
        lastUsedAt: Date.now(),
        acpClient: new AcpClientFacade({
          runId,
          instanceName,
          workspaceGuestRoot: WORKSPACE_GUEST_PATH,
          sandbox,
          log,
        }),
        nextRpcId: 1,
        pendingRpc: new Map(),
        initialized: false,
        initResult: null,
        seenSessionIds: new Set(),
        opQueue: Promise.resolve(),
        activePromptId: null,
      } satisfies RunRuntime);

    run.keepaliveTtlSeconds = keepaliveTtlSeconds;
    run.expiresAt = null;
    run.lastUsedAt = Date.now();
    runs.set(runId, run);

    const entrypointMode = sandbox.provider === "container_oci";
    if (entrypointMode) {
      const info = await sandbox.inspectInstance(instanceName);
      sendSandboxInstanceStatus({
        runId,
        instanceName,
        status: info.status === "missing" ? "missing" : info.status,
        lastError: null,
      });
      return run;
    }

    const info = await sandbox.ensureInstanceRunning({
      runId,
      instanceName,
      workspaceGuestPath: WORKSPACE_GUEST_PATH,
      env: undefined,
    });

    sendSandboxInstanceStatus({
      runId,
      instanceName,
      status: info.status === "missing" ? "missing" : info.status,
      lastError: null,
    });

    if (info.status !== "running") {
      throw new Error(`sandbox 实例未处于 running 状态：${info.status}`);
    }

    return run;
  };

  const runInitScript = async (opts: {
    run: RunRuntime;
    init?: {
      script?: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }): Promise<boolean> => {
    const script = opts.init?.script?.trim() ?? "";
    if (!script) return true;

    const timeoutSecondsRaw = opts.init?.timeout_seconds ?? 300;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
      : 300;

    const env = opts.init?.env ? { ...opts.init.env } : undefined;
    const secrets = pickSecretValues(env);
    const redact = (line: string) => redactSecrets(line, secrets);

    sendUpdate(opts.run.runId, {
      type: "text",
      text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
    });

    const proc = await sandbox.execProcess({
      instanceName: opts.run.instanceName,
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
            sendUpdate(opts.run.runId, {
              type: "text",
              text: `[init:${label}] ${text}`,
            });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {}
        const rest = redact(buf);
        if (rest.trim()) {
          sendUpdate(opts.run.runId, {
            type: "text",
            text: `[init:${label}] ${rest}`,
          });
        }
      }
    };

    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.onExit?.((info) => resolve(info));
    });
    const outP = readLines(proc.stdout, "stdout");
    const errP = readLines(proc.stderr, "stderr");

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raced.kind === "timeout") {
      sendUpdate(opts.run.runId, {
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
      sendUpdate(opts.run.runId, {
        type: "init_result",
        ok: false,
        exitCode: raced.code,
        error: `exitCode=${raced.code}`,
      });
      return false;
    }

    sendUpdate(opts.run.runId, { type: "init_result", ok: true });
    sendUpdate(opts.run.runId, { type: "text", text: "[init] done" });
    return true;
  };

  const handleAcpOpen = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    try {
      const run = await ensureRuntime(msg);
      const init = isRecord(msg.init) ? (msg.init as any) : undefined;

      await enqueueRunOp(run, async () => {
        const entrypointMode = sandbox.provider === "container_oci";
        if (!entrypointMode) {
          const initOk = await runInitScript({ run, init });
          if (!initOk) throw new Error("init_failed");
          await startAgent(run);
        } else {
          await startAgent(run, init);
        }

        await ensureInitialized(run);
      });
      send({ type: "acp_opened", run_id: runId, ok: true });
    } catch (err) {
      send({
        type: "acp_opened",
        run_id: runId,
        ok: false,
        error: String(err),
      });
    }
  };

  const handlePromptSend = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    const promptIdRaw = String(msg.prompt_id ?? "").trim();

    const reply = (payload: Record<string, unknown>) => {
      try {
        send({ type: "prompt_result", run_id: runId, prompt_id: promptIdRaw || null, ...payload });
      } catch (err) {
        log("failed to send prompt_result", { runId, err: String(err) });
      }
    };

    try {
      if (!promptIdRaw) {
        reply({ ok: false, error: "prompt_id 为空" });
        return;
      }

      const prompt = Array.isArray(msg.prompt) ? msg.prompt : null;
      if (!prompt) {
        reply({ ok: false, error: "prompt 必须是数组" });
        return;
      }

      const run = await ensureRuntime(msg);
      const init = isRecord(msg.init) ? (msg.init as any) : undefined;

      const cwd =
        typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : WORKSPACE_GUEST_PATH;
      const sessionId =
        typeof msg.session_id === "string" && msg.session_id.trim() ? msg.session_id.trim() : null;
      const context = typeof msg.context === "string" ? msg.context : undefined;

      const promptTimeoutMsRaw = msg.timeout_ms ?? null;
      const promptTimeoutMs = Number.isFinite(promptTimeoutMsRaw as number)
        ? Math.max(5_000, Math.min(24 * 3600 * 1000, Number(promptTimeoutMsRaw)))
        : 3600_000;

      await enqueueRunOp(run, async () => {
        const entrypointMode = sandbox.provider === "container_oci";
        if (!entrypointMode) {
          const initOk = await runInitScript({ run, init });
          if (!initOk) throw new Error("init_failed");
          await startAgent(run);
        } else {
          await startAgent(run, init);
        }

        await ensureInitialized(run);

        run.activePromptId = promptIdRaw;
        try {
          const ensured = await ensureSessionForPrompt(run, { cwd, sessionId, context, prompt });
          const caps = getPromptCapabilities(run.initResult);
          assertPromptBlocksSupported(ensured.prompt, caps);

          let usedSessionId = ensured.sessionId;
          let created = ensured.created;
          let recreatedFrom: string | null = null;

          let res: any;
          try {
            res = await withAuthRetry(run, () =>
              sendRpc<any>(
                run,
                "session/prompt",
                { sessionId: usedSessionId, prompt: ensured.prompt },
                { timeoutMs: promptTimeoutMs },
              ),
            );
          } catch (err) {
            if (shouldRecreateSession(err)) {
              recreatedFrom = usedSessionId;
              const createdRes = await withAuthRetry(run, () =>
                sendRpc<any>(run, "session/new", { cwd, mcpServers: [] }),
              );
              const newSessionId = String((createdRes as any)?.sessionId ?? "").trim();
              if (!newSessionId) throw err;
              run.seenSessionIds.add(newSessionId);
              usedSessionId = newSessionId;
              created = true;

              const replayCaps = getPromptCapabilities(run.initResult);
              const replay = composePromptWithContext(context, prompt, replayCaps);
              assertPromptBlocksSupported(replay, replayCaps);
              res = await withAuthRetry(run, () =>
                sendRpc<any>(
                  run,
                  "session/prompt",
                  { sessionId: usedSessionId, prompt: replay },
                  { timeoutMs: promptTimeoutMs },
                ),
              );
            } else {
              throw err;
            }
          }

          const stopReason = typeof res?.stopReason === "string" ? res.stopReason : "";

          reply({
            ok: true,
            session_id: usedSessionId,
            stop_reason: stopReason || null,
            session_created: created,
            session_recreated_from: recreatedFrom,
          });
        } finally {
          run.activePromptId = null;
        }
      });
    } catch (err) {
      reply({ ok: false, error: String(err) });
    }
  };

  const handleAcpMessage = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    const run = runs.get(runId);
    if (!run || !run.agent) {
      send({ type: "acp_error", run_id: runId, error: "run_not_open" });
      return;
    }

    const message = msg.message;
    if (!isJsonRpcMessage(message)) {
      send({
        type: "acp_error",
        run_id: runId,
        error: "invalid_jsonrpc_message",
      });
      return;
    }

    run.lastUsedAt = Date.now();
    await writeToAgent(run, message as any);
  };

  const handleAcpClose = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    const run = runs.get(runId);
    if (!run) return;

    await closeAgent(run, "requested");
    run.expiresAt = Date.now() + run.keepaliveTtlSeconds * 1000;

    try {
      send({ type: "acp_closed", run_id: runId, ok: true });
    } catch {
      // ignore
    }
  };

  const reportInventory = async () => {
    const capturedAt = nowIso();
    const inventoryId = randomUUID();
    const instances = await sandbox.listInstances({ managedOnly: true });
    send({
      type: "sandbox_inventory",
      inventory_id: inventoryId,
      provider: sandbox.provider,
      runtime: sandbox.provider === "container_oci" ? (sandbox.runtime ?? null) : null,
      captured_at: capturedAt,
      instances: instances.map((i) => {
        const runId = i.instanceName.startsWith("tuixiu-run-")
          ? i.instanceName.slice("tuixiu-run-".length)
          : null;
        return {
          instance_name: i.instanceName,
          run_id: runId,
          status: i.status,
          created_at: i.createdAt,
          last_seen_at: capturedAt,
        };
      }),
    });
  };

  const handleSandboxControl = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    const instanceNameRaw = String(msg.instance_name ?? "").trim();
    const action = String(msg.action ?? "").trim();

    const reply = (payload: Record<string, unknown>) => {
      try {
        send({
          type: "sandbox_control_result",
          run_id: runId || null,
          instance_name: instanceNameRaw || null,
          action,
          ...payload,
        });
      } catch (err) {
        log("failed to send sandbox_control_result", { err: String(err) });
      }
    };

    try {
      if (action === "report_inventory") {
        await reportInventory();
        reply({ ok: true });
        return;
      }

      const instanceName = validateInstanceName(instanceNameRaw);

      if (action === "inspect") {
        const info = await sandbox.inspectInstance(instanceName);
        if (runId) {
          sendSandboxInstanceStatus({
            runId,
            instanceName,
            status: info.status === "missing" ? "missing" : info.status,
            lastError: null,
          });
        }
        reply({
          ok: true,
          status: info.status,
          details: { created_at: info.createdAt },
        });
        return;
      }

      if (action === "ensure_running") {
        const effectiveRunId = validateRunId(runId);
        const info = await sandbox.ensureInstanceRunning({
          runId: effectiveRunId,
          instanceName,
          workspaceGuestPath: WORKSPACE_GUEST_PATH,
          env: undefined,
        });
        sendSandboxInstanceStatus({
          runId: effectiveRunId,
          instanceName,
          status: info.status === "missing" ? "missing" : info.status,
          lastError: null,
        });
        reply({
          ok: true,
          status: info.status,
          details: { created_at: info.createdAt },
        });
        return;
      }

      if (action === "stop") {
        if (runId) {
          const run = runs.get(runId);
          if (run) await closeAgent(run, "sandbox_control_stop");
        }
        await sandbox.stopInstance(instanceName);
        const info = await sandbox.inspectInstance(instanceName);
        if (runId) {
          sendSandboxInstanceStatus({
            runId,
            instanceName,
            status: info.status === "missing" ? "missing" : info.status,
            lastError: null,
          });
        }
        reply({ ok: true, status: info.status });
        return;
      }

      if (action === "remove") {
        if (runId) {
          const run = runs.get(runId);
          if (run) await closeAgent(run, "sandbox_control_remove");
          runs.delete(runId);
        }
        await sandbox.removeInstance(instanceName);
        if (runId) {
          sendSandboxInstanceStatus({
            runId,
            instanceName,
            status: "missing",
            lastError: null,
          });
        }
        reply({ ok: true, status: "missing" });
        return;
      }

      reply({ ok: false, error: "unsupported_action" });
    } catch (err) {
      const message = String(err);
      if (runId && instanceNameRaw) {
        sendSandboxInstanceStatus({
          runId,
          instanceName: instanceNameRaw,
          status: "error",
          lastError: message,
        });
      }
      reply({ ok: false, error: message });
    }
  };

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, run] of runs) {
      if (run.expiresAt == null) continue;
      if (now <= run.expiresAt) continue;
      void (async () => {
        await closeAgent(run, "keepalive_expired");
        await sandbox.removeInstance(run.instanceName).catch((err) => {
          log("sandbox remove failed", {
            runId,
            instanceName: run.instanceName,
            err: String(err),
          });
        });
        sendSandboxInstanceStatus({
          runId,
          instanceName: run.instanceName,
          status: "missing",
          lastError: null,
        });
        runs.delete(runId);
        log("run expired & removed", { runId, instanceName: run.instanceName });
      })();
    }
  }, 60_000);
  cleanupTimer.unref?.();

  const heartbeatLoop = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      await delay(cfg.heartbeat_seconds * 1000, { signal }).catch(() => {});
      if (signal.aborted) break;
      try {
        send({
          type: "heartbeat",
          agent_id: cfg.agent.id,
          timestamp: nowIso(),
        });
      } catch {
        // ignore
      }
    }
  };

  const connectLoop = async () => {
    for (;;) {
      try {
        log("connecting", { url: cfg.orchestrator_url });
        ws = new WebSocket(cfg.orchestrator_url);
        const ac = new AbortController();

        ws.on("message", (data) => {
          try {
            const text = data.toString();
            const msg = JSON.parse(text) as IncomingMessage;
            if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;

            if (msg.type === "acp_open") {
              void handleAcpOpen(msg);
              return;
            }
            if (msg.type === "prompt_send") {
              void handlePromptSend(msg);
              return;
            }
            if (msg.type === "acp_message") {
              void handleAcpMessage(msg);
              return;
            }
            if (msg.type === "acp_close") {
              void handleAcpClose(msg);
              return;
            }
            if (msg.type === "sandbox_control") {
              void handleSandboxControl(msg);
              return;
            }
          } catch (err) {
            log("failed to handle ws message", { err: String(err) });
          }
        });

        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error("ws init failed"));
          ws.on("open", () => resolve());
          ws.on("error", (err) => reject(err));
        });

        registerAgent();
        await reportInventory().catch((err) => {
          log("report inventory failed", { err: String(err) });
        });
        log("connected & registered");
        void heartbeatLoop(ac.signal);

        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error("ws init failed"));
          ws.on("close", () => resolve());
          ws.on("error", (err) => reject(err));
        });

        ac.abort();
      } catch (err) {
        log("connection failed; retrying", { err: String(err) });
      } finally {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
      }

      await delay(1000);
    }
  };

  await connectLoop();
}
