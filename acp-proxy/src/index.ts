import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";
import WebSocket from "ws";

import { loadConfig } from "./config.js";
import type { AgentUpdateMessage, IncomingMessage } from "./types.js";
import { DefaultAgentLauncher } from "./launchers/defaultLauncher.js";
import { HostProcessSandbox } from "./sandbox/hostProcessSandbox.js";
import { BoxliteSandbox } from "./sandbox/boxliteSandbox.js";

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

async function main() {
  const configPath = pickArg(process.argv.slice(2), "--config") ?? "config.json";
  const cfg = await loadConfig(configPath);

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const head = `[proxy] ${msg}`;
    if (extra) console.log(head, extra);
    else console.log(head);
  };

  if (cfg.sandbox.provider === "boxlite_oci") {
    if (!cfg.sandbox.boxlite?.image?.trim()) {
      throw new Error("sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite.image");
    }

    if (process.platform === "win32") {
      throw new Error(
        "BoxLite 不支持 Windows 原生运行，请在 WSL2/Linux 或 macOS(Apple Silicon) 上运行 acp-proxy，或改用 sandbox.provider=host_process",
      );
    }

    if (process.platform === "darwin" && process.arch !== "arm64") {
      throw new Error(
        "BoxLite 仅支持 macOS Apple Silicon(arm64)。Intel Mac 请改用 sandbox.provider=host_process 或在 Linux/WSL2 上运行 acp-proxy",
      );
    }

    if (process.platform === "linux") {
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK).catch(() => {
        throw new Error(
          "BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm",
        );
      });
    }
  }

  const isWsl = process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const mapWindowsPathToWsl = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (!isWsl) return raw;
    if (!cfg.pathMapping || cfg.pathMapping.type !== "windows_to_wsl") return raw;

    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(raw);
    if (!m) return raw;

    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    const mountRoot = cfg.pathMapping.wslMountRoot.replace(/[\\/]+$/, "");

    return rest ? `${mountRoot}/${drive}/${rest}` : `${mountRoot}/${drive}`;
  };

  const mapHostPathToBox = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (cfg.sandbox.provider !== "boxlite_oci") return raw;
    const volumes = cfg.sandbox.boxlite?.volumes ?? [];
    if (!volumes.length) return raw;

    const norm = raw.replace(/\\/g, "/");

    const candidates = volumes
      .map((v) => ({
        hostPath: mapWindowsPathToWsl(v.hostPath).replace(/\\/g, "/").replace(/\/+$/, ""),
        guestPath: v.guestPath.replace(/\\/g, "/").replace(/\/+$/, ""),
      }))
      .filter((v) => v.hostPath && v.guestPath);

    let best: { hostPath: string; guestPath: string } | null = null;
    for (const v of candidates) {
      if (norm === v.hostPath || norm.startsWith(`${v.hostPath}/`)) {
        if (!best || v.hostPath.length > best.hostPath.length) best = v;
      }
    }

    if (!best) return norm;
    return `${best.guestPath}${norm.slice(best.hostPath.length)}`;
  };

  const mapCwd = (cwd: string): string => mapHostPathToBox(mapWindowsPathToWsl(cwd));
  const defaultCwd = mapCwd(cfg.cwd);

  const sandbox =
    cfg.sandbox.provider === "boxlite_oci"
      ? new BoxliteSandbox({
          log,
          config: {
            image: cfg.sandbox.boxlite?.image ?? "",
            workingDir: cfg.sandbox.boxlite?.workingDir,
            volumes: cfg.sandbox.boxlite?.volumes,
            env: cfg.sandbox.boxlite?.env,
            cpus: cfg.sandbox.boxlite?.cpus,
            memoryMib: cfg.sandbox.boxlite?.memoryMib,
          },
        })
      : new HostProcessSandbox({ log });

  const launcher = new DefaultAgentLauncher({
    sandbox,
    command: cfg.agent_command,
  });

  type RunState = {
    cwd: string;
    transport: Awaited<ReturnType<(typeof launcher)["launch"]>>;
    stream: acp.Stream;
    lastUsedAt: number;
    writeQueue: Promise<void>;
    reader: ReadableStreamDefaultReader<acp.AnyMessage> | null;
  };

  const runStates = new Map<string, RunState>();
  const runToCwd = new Map<string, string>();

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    const msg: AgentUpdateMessage = {
      type: "agent_update",
      run_id: runId,
      content,
    };
    send(msg);
  };

  const setRunCwd = (runId: string, cwd: string) => {
    const value = mapCwd(cwd);
    if (!value) return;
    runToCwd.set(runId, value);
  };

  const getRunCwd = (runId: string, incomingCwd?: string): string => {
    if (typeof incomingCwd === "string" && incomingCwd.trim()) {
      setRunCwd(runId, incomingCwd);
      return runToCwd.get(runId) ?? defaultCwd;
    }
    return runToCwd.get(runId) ?? defaultCwd;
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities) ? cfg.agent.capabilities : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox) ? baseCaps.sandbox : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime) ? baseCaps.runtime : {};
    const baseBoxlite: Record<string, unknown> = isRecord(baseSandbox.boxlite) ? (baseSandbox.boxlite as Record<string, unknown>) : {};

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
    };
    if (cfg.sandbox.provider === "boxlite_oci") {
      sandboxCaps.boxlite = {
        ...baseBoxlite,
        image: cfg.sandbox.boxlite?.image ?? null,
        workingDir: cfg.sandbox.boxlite?.workingDir ?? null,
      };
    }

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

  const heartbeatLoop = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      await delay(cfg.heartbeat_seconds * 1000, { signal }).catch(() => {});
      if (signal.aborted) break;
      try {
        send({
          type: "heartbeat",
          agent_id: cfg.agent.id,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    }
  };

  const closeRun = async (runId: string, reason: string) => {
    const state = runStates.get(runId);
    if (!state) return;
    runStates.delete(runId);
    try {
      state.reader?.releaseLock();
    } catch {
      // ignore
    }
    await state.transport.close().catch(() => {});
    log("run closed", { runId, reason });
  };

  const runInitScript = async (opts: {
    runId: string;
    cwd: string;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }): Promise<boolean> => {
    const script = opts.init?.script?.trim();
    if (!script) return true;

    const timeoutSecondsRaw = opts.init?.timeout_seconds ?? 300;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, timeoutSecondsRaw))
      : 300;

    const env = opts.init?.env ? { ...process.env, ...opts.init.env } : process.env;
    const secrets = pickSecretValues(opts.init?.env);

    sendUpdate(opts.runId, {
      type: "text",
      text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
    });

    const proc = spawn("bash", ["-lc", script], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pump = (stream: NodeJS.ReadableStream, label: string) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const text = redactSecrets(String(chunk ?? ""), secrets).trimEnd();
        if (!text) return;
        sendUpdate(opts.runId, {
          type: "text",
          text: `[init:${label}] ${text}`,
        });
      });
    };
    pump(proc.stdout, "stdout");
    pump(proc.stderr, "stderr");

    const raced = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => {
        proc.once("exit", (code) => resolve({ code }));
        proc.once("error", () => resolve({ code: 1 }));
      }),
      delay(timeoutSeconds * 1000).then(() => ({ code: -1 })),
    ]);

    if (raced.code === -1) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        error: `timeout after ${timeoutSeconds}s`,
      });
      return false;
    }

    if (raced.code !== 0) {
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: raced.code,
        error: `exitCode=${raced.code}`,
      });
      return false;
    }

    sendUpdate(opts.runId, { type: "init_result", ok: true });
    sendUpdate(opts.runId, { type: "text", text: "[init] done" });
    return true;
  };

  const ensureRun = async (runId: string, cwd: string): Promise<RunState> => {
    const existing = runStates.get(runId);
    if (existing && existing.cwd === cwd) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (existing) {
      await closeRun(runId, "cwd_changed");
    }

    const transport = await launcher.launch({ cwd });
    const stream = acp.ndJsonStream(transport.input, transport.output);

    const state: RunState = {
      cwd,
      transport,
      stream,
      lastUsedAt: Date.now(),
      writeQueue: Promise.resolve(),
      reader: null,
    };
    runStates.set(runId, state);

    transport.onExit?.((info) => {
      void closeRun(runId, "agent_exit").finally(() => {
        try {
          send({ type: "acp_exit", run_id: runId, code: info.code, signal: info.signal });
        } catch {
          // ignore
        }
      });
    });

    const reader = stream.readable.getReader();
    state.reader = reader;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          state.lastUsedAt = Date.now();
          try {
            send({ type: "acp_message", run_id: runId, message: value });
          } catch (err) {
            log("failed to forward acp message", { runId, err: String(err) });
          }
        }
      } catch (err) {
        log("acp stream read failed", { runId, err: String(err) });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    })();

    return state;
  };

  const handleAcpOpen = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;

    const cwd = getRunCwd(runId, typeof msg.cwd === "string" ? msg.cwd : undefined);
    const init = isRecord(msg.init) ? (msg.init as any) : undefined;

    try {
      const initOk = await runInitScript({ runId, cwd, init });
      if (!initOk) {
        send({ type: "acp_opened", run_id: runId, ok: false, error: "init_failed" });
        return;
      }
      await ensureRun(runId, cwd);
      send({ type: "acp_opened", run_id: runId, ok: true });
    } catch (err) {
      send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
    }
  };

  const handleAcpMessage = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    const state = runStates.get(runId);
    if (!state) {
      send({ type: "acp_error", run_id: runId, error: "run_not_open" });
      return;
    }

    const message = msg.message;
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      send({ type: "acp_error", run_id: runId, error: "invalid_jsonrpc_message" });
      return;
    }

    state.lastUsedAt = Date.now();
    state.writeQueue = state.writeQueue
      .then(async () => {
        const writer = state.stream.writable.getWriter();
        try {
          await writer.write(message as any);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((err) => {
        log("acp write failed", { runId, err: String(err) });
      });
    await state.writeQueue;
  };

  const handleAcpClose = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;

    await closeRun(runId, "requested");
    try {
      send({ type: "acp_closed", run_id: runId, ok: true });
    } catch {
      // ignore
    }
  };

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, state] of runStates) {
      const idleMs = now - state.lastUsedAt;
      if (idleMs < 30 * 60 * 1000) continue;
      void closeRun(runId, "idle_timeout");
    }
  }, 60_000);
  idleTimer.unref?.();

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
        log("connected & registered");
        void heartbeatLoop(ac.signal);

        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error("ws init failed"));
          ws.on("message", (data) => {
            try {
              const text = data.toString();
              const msg = JSON.parse(text) as IncomingMessage;
              if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;

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

