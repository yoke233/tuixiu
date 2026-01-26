import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { loadConfig } from "./config.js";
import { Semaphore } from "./semaphore.js";
import type { AgentUpdateMessage, IncomingMessage } from "./types.js";
import { AcpBridge } from "./acpBridge.js";

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

function composePromptWithContext(context: string | undefined, prompt: string): string {
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

async function main() {
  const configPath = pickArg(process.argv.slice(2), "--config") ?? "config.json";
  const cfg = await loadConfig(configPath);

  const sem = new Semaphore(cfg.agent.max_concurrent);

  const runToSession = new Map<string, string>();
  const sessionToRun = new Map<string, string>();
  const chunkBySession = new Map<string, ChunkState>();
  const runToCwd = new Map<string, string>();

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const head = `[proxy] ${msg}`;
    if (extra) console.log(head, extra);
    else console.log(head);
  };

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    const msg: AgentUpdateMessage = { type: "agent_update", run_id: runId, content };
    try {
      send(msg);
    } catch (err) {
      log("send agent_update failed", { err: String(err) });
    }
  };

  const flushChunks = (sessionId: string): string => {
    const state = chunkBySession.get(sessionId);
    if (!state || !state.buf) return "";
    const out = state.buf;
    state.buf = "";
    state.lastFlush = Date.now();
    return out;
  };

  const appendChunk = (sessionId: string, text: string): string => {
    const now = Date.now();
    const state = chunkBySession.get(sessionId) ?? { buf: "", lastFlush: now };
    state.buf += text;
    chunkBySession.set(sessionId, state);
    if (text.includes("\n") || state.buf.length >= 256 || now - state.lastFlush >= 200) {
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

  const bridge = new AcpBridge({
    command: cfg.agent_command,
    cwd: cfg.cwd,
    log,
    onSessionUpdate: (sessionId, update) => {
      const runId = sessionToRun.get(sessionId);
      if (!runId) return;

      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        const flushed = appendChunk(sessionId, update.content.text);
        if (flushed) sendChunkUpdate(runId, sessionId, flushed);
        return;
      }

      const flushed = flushChunks(sessionId);
      if (flushed) sendChunkUpdate(runId, sessionId, flushed);

      sendUpdate(runId, { type: "session_update", session: sessionId, update });
    },
  });

  const setRunSession = (runId: string, sessionId: string) => {
    runToSession.set(runId, sessionId);
    sessionToRun.set(sessionId, runId);
  };

  const setRunCwd = (runId: string, cwd: string) => {
    const value = cwd.trim();
    if (!value) return;
    runToCwd.set(runId, value);
  };

  const getRunCwd = (runId: string, incomingCwd?: string): string => {
    if (typeof incomingCwd === "string" && incomingCwd.trim()) {
      setRunCwd(runId, incomingCwd);
      return incomingCwd.trim();
    }
    return runToCwd.get(runId) ?? cfg.cwd;
  };

  const registerAgent = () => {
    send({
      type: "register_agent",
      agent: {
        id: cfg.agent.id,
        name: cfg.agent.name ?? cfg.agent.id,
        max_concurrent: cfg.agent.max_concurrent,
        capabilities: cfg.agent.capabilities ?? {},
      },
    });
  };

  const heartbeatLoop = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      await delay(cfg.heartbeat_seconds * 1000, { signal }).catch(() => {});
      if (signal.aborted) break;
      try {
        send({ type: "heartbeat", agent_id: cfg.agent.id, timestamp: new Date().toISOString() });
      } catch {
        // ignore
      }
    }
  };

  const handleExecuteTask = async (msg: { run_id: string; prompt: string; cwd?: string }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, { type: "text", text: `[mock] received prompt: ${msg.prompt}` });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      await bridge.ensureInitialized();

      const cwd = getRunCwd(msg.run_id, msg.cwd);

      let sessionId = runToSession.get(msg.run_id) ?? "";
      if (!sessionId) {
        const s = await bridge.newSession(cwd);
        sessionId = s.sessionId;
        setRunSession(msg.run_id, sessionId);

        sendUpdate(msg.run_id, { type: "session_created", session_id: sessionId });
      }

      const res = await bridge.prompt(sessionId, msg.prompt);
      const flushed = flushChunks(sessionId);
      if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);

      sendUpdate(msg.run_id, { type: "prompt_result", stopReason: res.stopReason });
    } catch (err) {
      sendUpdate(msg.run_id, { type: "text", text: `执行失败: ${String(err)}` });
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
  }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, { type: "text", text: `[mock] prompt: ${msg.prompt}` });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      await bridge.ensureInitialized();

      const cwd = getRunCwd(msg.run_id, msg.cwd);

      let sessionId = msg.session_id || runToSession.get(msg.run_id) || "";
      if (!sessionId) {
        const s = await bridge.newSession(cwd);
        sessionId = s.sessionId;
        setRunSession(msg.run_id, sessionId);
        sendUpdate(msg.run_id, { type: "session_created", session_id: sessionId });
        msg = { ...msg, prompt: composePromptWithContext(msg.context, msg.prompt) };
      } else {
        const sessionPreviouslySeen = sessionToRun.has(sessionId);
        setRunSession(msg.run_id, sessionId);

        // 仅当本进程没见过该 session 时，尝试 load 历史会话。
        // 若 load 失败（agent 不支持 / session 不存在），不自动新建 session，避免上下文丢失。
        if (!sessionPreviouslySeen) {
          const ok = await bridge.loadSession(sessionId, cwd);
          if (!ok) {
            sendUpdate(msg.run_id, { type: "text", text: "ACP session 无法 load（可能不支持或已丢失），将尝试直接对话…" });
          }
        }
      }

      let res: { stopReason: string };
      try {
        res = await bridge.prompt(sessionId, msg.prompt);
      } catch (err) {
        if (shouldRecreateSession(err)) {
          sendUpdate(msg.run_id, { type: "text", text: "⚠️ ACP session 疑似已丢失：将创建新 session 并注入上下文继续…" });
          const s = await bridge.newSession(cwd);
          sessionId = s.sessionId;
          setRunSession(msg.run_id, sessionId);
          sendUpdate(msg.run_id, { type: "session_created", session_id: sessionId });

          const replay = composePromptWithContext(msg.context, msg.prompt);
          res = await bridge.prompt(sessionId, replay);
        } else {
          sendUpdate(msg.run_id, { type: "text", text: `ACP prompt 失败：${String(err)}` });
          return;
        }
      }

      const flushed = flushChunks(sessionId);
      if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);
      sendUpdate(msg.run_id, { type: "prompt_result", stopReason: res.stopReason });
    } catch (err) {
      sendUpdate(msg.run_id, { type: "text", text: `对话失败: ${String(err)}` });
    } finally {
      release();
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
              if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;

              if (msg.type === "execute_task" && typeof msg.run_id === "string" && typeof msg.prompt === "string") {
                void handleExecuteTask({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                });
                return;
              }

              if (msg.type === "prompt_run" && typeof msg.run_id === "string" && typeof msg.prompt === "string") {
                void handlePromptRun({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  session_id: typeof msg.session_id === "string" ? msg.session_id : undefined,
                  context: typeof msg.context === "string" ? msg.context : undefined,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                });
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
