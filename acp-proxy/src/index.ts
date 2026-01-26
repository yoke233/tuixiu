import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { loadConfig } from "./config.js";
import { Semaphore } from "./semaphore.js";
import type { AgentUpdateMessage, IncomingMessage } from "./types.js";
import { AcpBridge } from "./acpBridge.js";
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

type ChunkState = { buf: string; lastFlush: number };

function shouldRecreateSession(err: unknown): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("session") || msg.includes("sessionid");
}

function composePromptWithContext(
  context: string | undefined,
  prompt: string,
): string {
  const ctx = context?.trim();
  if (!ctx) return prompt;
  return [
    "你正在接手一个可能因为进程重启导致 ACP session 丢失的任务。",
    "下面是系统保存的上下文（Issue 信息 + 最近对话节选）。请先阅读、恢复当前进度，然后继续响应用户的新消息。",
    "",
    "=== 上下文开始 ===",
    ctx,
    "=== 上下文结束 ===",
    "",
    `用户: ${prompt}`,
  ].join("\n");
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
  const configPath =
    pickArg(process.argv.slice(2), "--config") ?? "config.json";
  const cfg = await loadConfig(configPath);

  const sem = new Semaphore(cfg.agent.max_concurrent);

  type RunState = {
    cwd: string;
    bridge: AcpBridge;
    sessionId: string;
    seenSessionIds: Set<string>;
    loadingSessionId: string | null;
    lastUsedAt: number;
    inFlight: number;
  };

  const runStates = new Map<string, RunState>();
  const chunkByStream = new Map<string, ChunkState>();
  const runToCwd = new Map<string, string>();

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const head = `[proxy] ${msg}`;
    if (extra) console.log(head, extra);
    else console.log(head);
  };

  if (cfg.sandbox.provider === "boxlite_oci") {
    if (!cfg.sandbox.boxlite?.image?.trim()) {
      throw new Error(
        "sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite.image",
      );
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
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK).catch(
        () => {
          throw new Error(
            "BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm",
          );
        },
      );
    }

    // @ts-expect-error - optional dependency (only needed when sandbox.provider=boxlite_oci)
    await import("@boxlite-ai/boxlite").catch(async () => {
      // @ts-expect-error - optional dependency (package name differs by release channel)
      await import("boxlite").catch(() => {
        throw new Error(
          "未安装 BoxLite Node SDK。请在 WSL2/Linux/macOS(Apple Silicon) 环境执行: pnpm -C acp-proxy add @boxlite-ai/boxlite（或 pnpm -C acp-proxy add boxlite）",
        );
      });
    });
  }

  const isWsl =
    process.platform === "linux" &&
    !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const mapWindowsPathToWsl = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (!isWsl) return raw;
    if (!cfg.pathMapping || cfg.pathMapping.type !== "windows_to_wsl")
      return raw;

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
        hostPath: mapWindowsPathToWsl(v.hostPath)
          .replace(/\\/g, "/")
          .replace(/\/+$/, ""),
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

  const mapCwd = (cwd: string): string =>
    mapHostPathToBox(mapWindowsPathToWsl(cwd));

  const defaultCwd = mapCwd(cfg.cwd);

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    const msg: AgentUpdateMessage = {
      type: "agent_update",
      run_id: runId,
      content,
    };
    try {
      send(msg);
    } catch (err) {
      log("send agent_update failed", { err: String(err) });
    }
  };

  const streamKey = (runId: string, sessionId: string) => `${runId}:${sessionId}`;

  const flushChunks = (runId: string, sessionId: string): string => {
    const state = chunkByStream.get(streamKey(runId, sessionId));
    if (!state || !state.buf) return "";
    const out = state.buf;
    state.buf = "";
    state.lastFlush = Date.now();
    return out;
  };

  const appendChunk = (runId: string, sessionId: string, text: string): string => {
    const now = Date.now();
    const key = streamKey(runId, sessionId);
    const state = chunkByStream.get(key) ?? { buf: "", lastFlush: now };
    state.buf += text;
    chunkByStream.set(key, state);
    if (
      text.includes("\n") ||
      state.buf.length >= 256 ||
      now - state.lastFlush >= 200
    ) {
      const out = state.buf;
      state.buf = "";
      state.lastFlush = now;
      return out;
    }
    return "";
  };

  const sendChunkUpdate = (runId: string, sessionId: string, text: string) => {
    sendUpdate(runId, {
      type: "session_update",
      session: sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  };

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

  const createRunState = (
    runId: string,
    cwd: string,
    seed?: { sessionId?: string },
  ): RunState => {
    const state: RunState = {
      cwd,
      bridge: null as any,
      sessionId: typeof seed?.sessionId === "string" ? seed.sessionId : "",
      seenSessionIds: new Set<string>(),
      loadingSessionId: null,
      lastUsedAt: Date.now(),
      inFlight: 0,
    };

    state.bridge = new AcpBridge({
      launcher,
      cwd,
      log,
      onSessionUpdate: (sessionId, update) => {
        if (state.loadingSessionId === sessionId) return;
        state.lastUsedAt = Date.now();

        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          const flushed = appendChunk(runId, sessionId, update.content.text);
          if (flushed) sendChunkUpdate(runId, sessionId, flushed);
          return;
        }

        const flushed = flushChunks(runId, sessionId);
        if (flushed) sendChunkUpdate(runId, sessionId, flushed);

        sendUpdate(runId, { type: "session_update", session: sessionId, update });
      },
    });

    return state;
  };

  const getOrCreateRunState = (runId: string, cwd: string): RunState => {
    const existing = runStates.get(runId);
    if (!existing) {
      const created = createRunState(runId, cwd);
      runStates.set(runId, created);
      return created;
    }

    existing.lastUsedAt = Date.now();
    if (existing.cwd === cwd) return existing;

    log("run cwd changed; respawn agent", { runId, from: existing.cwd, to: cwd });
    existing.bridge.close();

    const recreated = createRunState(runId, cwd, { sessionId: existing.sessionId });
    runStates.set(runId, recreated);
    return recreated;
  };

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, state] of runStates) {
      if (state.inFlight > 0) continue;
      const idleMs = now - state.lastUsedAt;
      if (idleMs < 30 * 60 * 1000) continue;
      log("run idle; close agent", { runId, idleSeconds: Math.round(idleMs / 1000) });
      state.bridge.close();
      runStates.delete(runId);
      for (const key of chunkByStream.keys()) {
        if (key.startsWith(`${runId}:`)) chunkByStream.delete(key);
      }
    }
  }, 60_000);
  idleTimer.unref?.();

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
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox)
      ? baseCaps.sandbox
      : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime)
      ? baseCaps.runtime
      : {};
    const baseBoxlite: Record<string, unknown> = isRecord(baseSandbox.boxlite)
      ? (baseSandbox.boxlite as Record<string, unknown>)
      : {};

    const runtime: Record<string, unknown> = {
      ...baseRuntime,
      platform: process.platform,
      arch: process.arch,
      isWsl,
      wslDistro: process.env.WSL_DISTRO_NAME ?? null,
    };

    const sandbox: Record<string, unknown> = {
      ...baseSandbox,
      provider: cfg.sandbox.provider,
    };
    if (cfg.sandbox.provider === "boxlite_oci") {
      sandbox.boxlite = {
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
        capabilities: { ...baseCaps, runtime, sandbox },
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

    const env = opts.init?.env
      ? { ...process.env, ...opts.init.env }
      : process.env;
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

    const makeLineSink = (label: "stdout" | "stderr") => {
      let buf = "";
      return {
        onChunk(chunk: Buffer) {
          buf += chunk.toString("utf8");
          const parts = buf.split(/\r?\n/g);
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const text = redactSecrets(line, secrets);
            if (!text.trim()) continue;
            sendUpdate(opts.runId, {
              type: "text",
              text: `[init:${label}] ${text}`,
            });
          }
        },
        flush() {
          const text = redactSecrets(buf, secrets);
          if (text.trim())
            sendUpdate(opts.runId, {
              type: "text",
              text: `[init:${label}] ${text}`,
            });
          buf = "";
        },
      };
    };

    const out = makeLineSink("stdout");
    const err = makeLineSink("stderr");
    proc.stdout?.on("data", (c: Buffer) => out.onChunk(c));
    proc.stderr?.on("data", (c: Buffer) => err.onChunk(c));

    const exitP = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const errorP = new Promise<Error>((resolve) => {
      proc.once("error", (e) => resolve(e));
    });

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      errorP.then((e) => ({ kind: "error" as const, error: e })),
      delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raced.kind === "timeout") {
      sendUpdate(opts.runId, {
        type: "text",
        text: `[init] timeout after ${timeoutSeconds}s`,
      });
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      const { code, signal } = await exitP.catch(() => ({
        code: null,
        signal: null,
      }));
      out.flush();
      err.flush();
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: code,
        error: `timeout (signal=${String(signal ?? "")})`,
      });
      return false;
    }

    if (raced.kind === "error") {
      out.flush();
      err.flush();
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: null,
        error: String(raced.error),
      });
      return false;
    }

    out.flush();
    err.flush();

    if (raced.code === 0) {
      sendUpdate(opts.runId, { type: "text", text: "[init] done" });
      sendUpdate(opts.runId, { type: "init_result", ok: true, exitCode: 0 });
      return true;
    }

    sendUpdate(opts.runId, {
      type: "init_result",
      ok: false,
      exitCode: raced.code,
      error: `exitCode=${raced.code}`,
    });
    return false;
  };

  const handleExecuteTask = async (msg: {
    run_id: string;
    prompt: string;
    cwd?: string;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: `[mock] received prompt: ${msg.prompt}`,
        });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id, msg.cwd);

      const initOk = await runInitScript({
        runId: msg.run_id,
        cwd,
        init: msg.init,
      });
      if (!initOk) return;

      const state = getOrCreateRunState(msg.run_id, cwd);
      state.inFlight += 1;
      try {
        await state.bridge.ensureInitialized();

        let sessionId = state.sessionId;
        if (!sessionId) {
          const s = await state.bridge.newSession(cwd);
          sessionId = s.sessionId;
          state.sessionId = sessionId;
          state.seenSessionIds.add(sessionId);

          sendUpdate(msg.run_id, {
            type: "session_created",
            session_id: sessionId,
          });
        }

        const res = await state.bridge.prompt(sessionId, msg.prompt);
        const flushed = flushChunks(msg.run_id, sessionId);
        if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);

        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: res.stopReason,
        });
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: `执行失败: ${String(err)}`,
      });
    } finally {
      release();
    }
  };

  const handlePromptRun = async (msg: {
    run_id: string;
    prompt: string;
    session_id?: string;
    context?: string;
    cwd?: string;
    resume?: boolean;
  }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: `[mock] prompt: ${msg.prompt}`,
        });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id, msg.cwd);
      const state = getOrCreateRunState(msg.run_id, cwd);
      state.inFlight += 1;
      try {
        await state.bridge.ensureInitialized();

        let sessionId = msg.session_id || state.sessionId || "";
        if (!sessionId) {
          const s = await state.bridge.newSession(cwd);
          sessionId = s.sessionId;
          state.sessionId = sessionId;
          state.seenSessionIds.add(sessionId);
          sendUpdate(msg.run_id, {
            type: "session_created",
            session_id: sessionId,
          });
          msg = {
            ...msg,
            prompt: composePromptWithContext(msg.context, msg.prompt),
          };
        } else {
          state.sessionId = sessionId;
          const sessionPreviouslySeen = state.seenSessionIds.has(sessionId);

          // 仅当本进程没见过该 session 时，尝试 load 历史会话。
          // 若 load 失败（agent 不支持 / session 不存在），不自动新建 session，避免上下文丢失。
          if (!sessionPreviouslySeen) {
            let ok = false;
            try {
              state.loadingSessionId = sessionId;
              ok = await state.bridge.loadSession(sessionId, cwd);
            } finally {
              state.loadingSessionId = null;
            }
            state.seenSessionIds.add(sessionId);
            if (!ok) {
              sendUpdate(msg.run_id, {
                type: "text",
                text: "ACP session 无法 load（可能不支持或已丢失），将尝试直接对话…",
              });
            }
          }
        }

        let res: { stopReason: string };
        try {
          res = await state.bridge.prompt(sessionId, msg.prompt);
        } catch (err) {
          if (shouldRecreateSession(err)) {
            sendUpdate(msg.run_id, {
              type: "text",
              text: "⚠️ ACP session 疑似已丢失：将创建新 session 并注入上下文继续…",
            });
            const s = await state.bridge.newSession(cwd);
            sessionId = s.sessionId;
            state.sessionId = sessionId;
            state.seenSessionIds.add(sessionId);
            sendUpdate(msg.run_id, {
              type: "session_created",
              session_id: sessionId,
            });

            const replay = composePromptWithContext(msg.context, msg.prompt);
            res = await state.bridge.prompt(sessionId, replay);
          } else {
            sendUpdate(msg.run_id, {
              type: "text",
              text: `ACP prompt 失败：${String(err)}`,
            });
            return;
          }
        }

        const flushed = flushChunks(msg.run_id, sessionId);
        if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: res.stopReason,
        });
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: `对话失败: ${String(err)}`,
      });
    } finally {
      release();
    }
  };

  const handleCancelTask = async (msg: { run_id: string; session_id?: string }) => {
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: "[mock] cancel_task",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id);
      const state = getOrCreateRunState(msg.run_id, cwd);
      const sessionId = msg.session_id || state.sessionId || "";
      if (!sessionId) return;

      state.inFlight += 1;
      try {
        await state.bridge.cancel(sessionId);
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: "取消失败: " + String(err),
      });
    }
  };


  const handleSessionCancel = async (msg: { run_id: string; session_id?: string }) => {
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: "[mock] session/cancel",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id);
      const state = getOrCreateRunState(msg.run_id, cwd);

      const sessionId = msg.session_id || state.sessionId || "";
      if (!sessionId) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: "无法暂停：ACP sessionId 未知（尚未建立或尚未同步）",
        });
        return;
      }

      state.sessionId = sessionId;
      state.seenSessionIds.add(sessionId);

      state.inFlight += 1;
      try {
        await state.bridge.cancel(sessionId);
      } finally {
        state.inFlight = Math.max(0, state.inFlight - 1);
      }

      sendUpdate(msg.run_id, {
        type: "text",
        text: "已向 Agent 发送暂停请求（ACP session/cancel）",
      });
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: "暂停失败: " + String(err),
      });
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

              if (msg.type === "cancel_task" && typeof msg.run_id === "string") {
                void handleCancelTask({
                  run_id: msg.run_id,
                  session_id:
                    typeof msg.session_id === "string" ? msg.session_id : undefined,
                });
                return;
              }

              if (
                msg.type === "execute_task" &&
                typeof msg.run_id === "string" &&
                typeof msg.prompt === "string"
              ) {
                const initRaw = (msg as any).init;
                let init:
                  | {
                      script: string;
                      timeout_seconds?: number;
                      env?: Record<string, string>;
                    }
                  | undefined;
                if (isRecord(initRaw) && typeof initRaw.script === "string") {
                  const envRaw = initRaw.env;
                  const env = isRecord(envRaw)
                    ? Object.fromEntries(
                        Object.entries(envRaw).filter(
                          (entry): entry is [string, string] =>
                            typeof entry[1] === "string",
                        ),
                      )
                    : undefined;
                  const timeoutSeconds =
                    typeof initRaw.timeout_seconds === "number"
                      ? initRaw.timeout_seconds
                      : typeof initRaw.timeout_seconds === "string"
                        ? Number(initRaw.timeout_seconds)
                        : undefined;
                  init = {
                    script: initRaw.script,
                    timeout_seconds: Number.isFinite(timeoutSeconds as number)
                      ? (timeoutSeconds as number)
                      : undefined,
                    env,
                  };
                }
                void handleExecuteTask({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                  init,
                });
                return;
              }

              if (
                msg.type === "prompt_run" &&
                typeof msg.run_id === "string" &&
                typeof msg.prompt === "string"
              ) {
                void handlePromptRun({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  session_id:
                    typeof msg.session_id === "string"
                      ? msg.session_id
                      : undefined,
                  context:
                    typeof msg.context === "string" ? msg.context : undefined,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                  resume: (msg as any).resume === true,
                });
              }


              if (msg.type === "session_cancel" && typeof msg.run_id === "string") {
                void handleSessionCancel({
                  run_id: msg.run_id,
                  session_id:
                    typeof msg.session_id === "string" ? msg.session_id : undefined,
                });
                return;
              }
            } catch (err) {
              log("bad ws message", { err: String(err) });
            }
          });
          ws.on("close", () => resolve());
          ws.on("error", (err) => reject(err));
        }).finally(() => {
          ac.abort();
        });
      } catch (err) {
        log("ws error", { err: String(err) });
      } finally {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
      }

      await delay(2000);
    }
  };

  await connectLoop();
}

main().catch((err) => {
  console.error("[proxy] fatal", err);
  process.exitCode = 1;
});
