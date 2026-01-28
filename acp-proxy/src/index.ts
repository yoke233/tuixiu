import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  lastUsedAt: number;
  acpClient: AcpClientFacade;
};

async function main() {
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
    process.platform === "linux" &&
    !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

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
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new Error("ws not connected");
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
      runtime: sandbox.provider === "container_oci" ? sandbox.runtime ?? null : null,
      status: opts.status,
      last_seen_at: nowIso(),
      last_error: opts.lastError ?? null,
    });
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox)
      ? baseCaps.sandbox
      : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime)
      ? baseCaps.runtime
      : {};

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
    run.agent = null;
    try {
      agent.reader.releaseLock();
    } catch {
      // ignore
    }
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

  const startAgent = async (run: RunRuntime) => {
    if (run.agent) return;

    let handle: Awaited<ReturnType<typeof sandbox.execProcess>>;
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
      ];
      const redact = (line: string) => redactSecrets(line, secrets);

      const stderr = handle.stderr;
      if (!stderr) return;

      const decoder = new TextDecoder();
      const reader = stderr.getReader();
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
            log("agent stderr", { runId: run.runId, text });
            sendUpdate(run.runId, { type: "text", text: `[agent:stderr] ${text}` });
          }
        }
      } catch (err) {
        log("agent stderr read failed", { runId: run.runId, err: String(err) });
      } finally {
        try {
          reader.releaseLock();
        } catch {}
        const rest = redact(buf);
        if (rest.trim()) {
          log("agent stderr", { runId: run.runId, text: rest });
          sendUpdate(run.runId, { type: "text", text: `[agent:stderr] ${rest}` });
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

          try {
            send({ type: "acp_message", run_id: run.runId, message: value });
          } catch (err) {
            log("failed to forward acp message", {
              runId: run.runId,
              err: String(err),
            });
          }
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
        lastUsedAt: Date.now(),
        acpClient: new AcpClientFacade({
          runId,
          instanceName,
          workspaceGuestRoot: WORKSPACE_GUEST_PATH,
          sandbox,
          log,
        }),
      } satisfies RunRuntime);

    run.keepaliveTtlSeconds = keepaliveTtlSeconds;
    run.expiresAt = null;
    run.lastUsedAt = Date.now();
    runs.set(runId, run);

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
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
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

    const exitP = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        proc.onExit?.((info) => resolve(info));
      },
    );
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
      const initOk = await runInitScript({ run, init });
      if (!initOk) {
        send({ type: "acp_opened", run_id: runId, ok: false, error: "init_failed" });
        return;
      }
      await startAgent(run);
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
      runtime: sandbox.provider === "container_oci" ? sandbox.runtime ?? null : null,
      captured_at: capturedAt,
      instances: instances.map((i) => {
        const runId =
          i.instanceName.startsWith("tuixiu-run-")
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
          ws.on("message", (data) => {
            try {
              const text = data.toString();
              const msg = JSON.parse(text) as IncomingMessage;
              if (!msg || !isRecord(msg) || typeof msg.type !== "string")
                return;

              if (msg.type === "acp_open") {
                void handleAcpOpen(msg);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
