import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import * as acp from "@agentclientprotocol/sdk";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS, deriveSandboxInstanceName } from "../utils/sandbox.js";
import { advanceTaskFromRunTerminal } from "./taskProgress.js";
import { triggerPmAutoAdvance } from "./pm/pmAutoAdvance.js";
import type { AcpContentBlock } from "./acpContent.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type AcpOpenPayload = {
  script: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
};

type OpenDeferred = {
  resolve: () => void;
  reject: (err: Error) => void;
};

type TerminalExitStatus = { exitCode?: number | null; signal?: string | null };

type ManagedTerminal = {
  sessionId: string;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus: TerminalExitStatus | null;
  exitPromise: Promise<TerminalExitStatus>;
  kill: () => Promise<void>;
  release: () => Promise<void>;
};

type RunTunnelState = {
  proxyId: string;
  runId: string;
  cwd: string;
  opened: boolean;
  opening: Promise<void> | null;
  openDeferred: OpenDeferred | null;
  stream: acp.Stream;
  controller: ReadableStreamDefaultController<acp.AnyMessage> | null;
  conn: acp.ClientSideConnection;
  initialized: boolean;
  initResult: acp.InitializeResponse | null;
  seenSessionIds: Set<string>;
  terminals: Map<string, ManagedTerminal>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type PromptCapabilities = {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
};

function getPromptCapabilities(initResult: acp.InitializeResponse | null): PromptCapabilities {
  const caps = (initResult as any)?.agentCapabilities?.promptCapabilities;
  return isRecord(caps) ? (caps as PromptCapabilities) : {};
}

function assertPromptBlocksSupported(prompt: readonly AcpContentBlock[], promptCapabilities: PromptCapabilities) {
  for (const block of prompt) {
    switch (block.type) {
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
          throw new Error("Agent 未启用 promptCapabilities.embeddedContext，无法发送 resource(embedded) 类型内容");
        }
        break;
      default:
        throw new Error(`未知的 ACP content block type: ${(block as any).type}`);
    }
  }
}

function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as any).code;
  return code === -32000;
}

function shouldRecreateSession(err: unknown): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("session") || msg.includes("sessionid");
}

function composePromptWithContext(
  context: string | undefined,
  prompt: AcpContentBlock[],
  promptCapabilities: PromptCapabilities,
): AcpContentBlock[] {
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

function trimToByteLimit(value: string, limit: number): { value: string; truncated: boolean } {
  if (limit <= 0) return { value: "", truncated: true };
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { value, truncated: false };

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const slice = value.slice(mid);
    if (Buffer.byteLength(slice, "utf8") > limit) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let trimmed = value.slice(low);
  while (trimmed && Buffer.byteLength(trimmed, "utf8") > limit) {
    trimmed = trimmed.slice(1);
  }
  return { value: trimmed, truncated: true };
}

function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const base = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(base, requestedPath);

  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const within =
    process.platform === "win32"
      ? resolved.toLowerCase().startsWith(baseWithSep.toLowerCase()) || resolved.toLowerCase() === base.toLowerCase()
      : resolved.startsWith(baseWithSep) || resolved === base;

  if (!within) throw acp.RequestError.invalidParams({ path: "Path is outside workspace root" });
  return resolved;
}

function buildSpawnCommand(rawCmd: string, args: string[]): { cmd: string; args: string[] } {
  const lower = rawCmd.toLowerCase();
  const useCmdShim =
    process.platform === "win32" &&
    (lower === "npx" ||
      lower === "npm" ||
      lower === "pnpm" ||
      lower === "yarn" ||
      lower.endsWith(".cmd") ||
      lower.endsWith(".bat"));

  const cmd = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : rawCmd;
  const nextArgs = useCmdShim ? ["/d", "/s", "/c", rawCmd, ...args] : args;
  return { cmd, args: nextArgs };
}

const CHUNK_SESSION_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);
const CHUNK_FLUSH_INTERVAL_MS = 800;
const CHUNK_MAX_BUFFER_CHARS = 16_000;
type BufferedChunkSegment = {
  session: string;
  sessionUpdate: string;
  text: string;
};
type RunChunkBuffer = {
  segments: BufferedChunkSegment[];
  totalChars: number;
  timer: NodeJS.Timeout | null;
};

export function createAcpTunnel(deps: {
  prisma: PrismaDeps;
  sendToAgent: SendToAgent;
  broadcastToClients?: (payload: unknown) => void;
  log?: Logger;
}) {
  const log: Logger = deps.log ?? (() => {});

  const runStates = new Map<string, RunTunnelState>();
  const chunkBuffersByRun = new Map<string, RunChunkBuffer>();
  const runQueue = new Map<string, Promise<void>>();

  function enqueueRunTask(runId: string, task: () => Promise<void>): Promise<void> {
    const prev = runQueue.get(runId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (runQueue.get(runId) === next) runQueue.delete(runId);
      });
    runQueue.set(runId, next);
    return next;
  }

  async function resolveSandboxOpenParams(runId: string): Promise<{ instanceName: string; keepaliveTtlSeconds: number }> {
    const run = await deps.prisma.run
      .findUnique({
        where: { id: runId },
        select: { sandboxInstanceName: true, keepaliveTtlSeconds: true },
      } as any)
      .catch(() => null);

    const instanceNameRaw = run && typeof (run as any).sandboxInstanceName === "string" ? String((run as any).sandboxInstanceName) : "";
    const instanceName = instanceNameRaw.trim() ? instanceNameRaw.trim() : deriveSandboxInstanceName(runId);

    const ttlRaw = run && typeof (run as any).keepaliveTtlSeconds === "number" ? Number((run as any).keepaliveTtlSeconds) : NaN;
    const keepaliveTtlSeconds = Number.isFinite(ttlRaw)
      ? Math.min(86_400, Math.max(60, Math.trunc(ttlRaw)))
      : DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS;

    if (
      run &&
      (instanceNameRaw.trim() !== instanceName ||
        !Number.isFinite(ttlRaw) ||
        Math.trunc(ttlRaw) !== keepaliveTtlSeconds)
    ) {
      await deps.prisma.run
        .update({
          where: { id: runId },
          data: { sandboxInstanceName: instanceName, keepaliveTtlSeconds } as any,
        } as any)
        .catch(() => {});
    }

    return { instanceName, keepaliveTtlSeconds };
  }

  async function flushRunChunkBuffer(runId: string) {
    const buf = chunkBuffersByRun.get(runId);
    if (!buf || !buf.segments.length) return;

    if (buf.timer) clearTimeout(buf.timer);
    chunkBuffersByRun.delete(runId);

    for (const seg of buf.segments) {
      const createdEvent = await deps.prisma.event.create({
        data: {
          id: uuidv7(),
          runId,
          source: "acp",
          type: "acp.update.received",
          payload: {
            type: "session_update",
            session: seg.session,
            update: {
              sessionUpdate: seg.sessionUpdate,
              content: { type: "text", text: seg.text },
            },
          } as any,
        },
      });
      deps.broadcastToClients?.({ type: "event_added", run_id: runId, event: createdEvent });
    }
  }

  async function bufferChunkSegment(runId: string, seg: BufferedChunkSegment): Promise<void> {
    const buf: RunChunkBuffer =
      chunkBuffersByRun.get(runId) ??
      {
        segments: [],
        totalChars: 0,
        timer: null,
      };

    const maxSegmentChars = CHUNK_MAX_BUFFER_CHARS;
    const text = seg.text.length > maxSegmentChars ? seg.text.slice(0, maxSegmentChars) : seg.text;

    const last = buf.segments.length ? buf.segments[buf.segments.length - 1] : null;
    if (last && last.session === seg.session && last.sessionUpdate === seg.sessionUpdate) {
      last.text += text;
    } else {
      buf.segments.push({ ...seg, text });
    }
    buf.totalChars += text.length;
    chunkBuffersByRun.set(runId, buf);

    if (buf.totalChars >= CHUNK_MAX_BUFFER_CHARS) {
      await flushRunChunkBuffer(runId);
      return;
    }

    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        void enqueueRunTask(runId, async () => {
          await flushRunChunkBuffer(runId);
        });
      }, CHUNK_FLUSH_INTERVAL_MS);
      buf.timer.unref?.();
    }
  }

  async function persistSessionUpdate(runId: string, sessionId: string, update: acp.SessionNotification["update"]) {
    const sessionUpdate = typeof (update as any).sessionUpdate === "string" ? String((update as any).sessionUpdate) : "";
    const content = (update as any).content;

    if (CHUNK_SESSION_UPDATES.has(sessionUpdate) && content?.type === "text" && typeof content.text === "string" && content.text) {
      await bufferChunkSegment(runId, { session: sessionId, sessionUpdate, text: content.text });
      return;
    }

    await flushRunChunkBuffer(runId);

    const createdEvent = await deps.prisma.event.create({
      data: {
        id: uuidv7(),
        runId,
        source: "acp",
        type: "acp.update.received",
        payload: {
          type: "session_update",
          session: sessionId,
          update,
        } as any,
      },
    });
    deps.broadcastToClients?.({ type: "event_added", run_id: runId, event: createdEvent });
  }

  async function updateSessionState(runId: string, patch: Partial<Record<string, unknown>>) {
    const run = await deps.prisma.run.findUnique({ where: { id: runId }, select: { metadata: true, acpSessionId: true } }).catch(() => null);
    const prev = run && isRecord(run.metadata) ? (run.metadata as Record<string, unknown>) : {};
    const existing = isRecord(prev.acpSessionState) ? (prev.acpSessionState as Record<string, unknown>) : {};
    const next = { ...existing, ...patch };
    await deps.prisma.run.update({ where: { id: runId }, data: { metadata: { ...prev, acpSessionState: next } as any } }).catch(() => {});
  }

  function createClientImpl(state: RunTunnelState): acp.Client {
    return {
      requestPermission: async (params) => {
        const preferred = params.options.find((o) => o.kind === "allow_once") ?? params.options[0] ?? null;
        if (!preferred) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: preferred.optionId } };
      },
      sessionUpdate: async (params) => {
        await enqueueRunTask(state.runId, async () => {
          await persistSessionUpdate(state.runId, params.sessionId, params.update);
          if ((params.update as any).sessionUpdate === "current_mode_update") {
            await updateSessionState(state.runId, {
              sessionId: params.sessionId,
              currentModeId: (params.update as any).currentModeId,
              updatedAt: new Date().toISOString(),
            });
          }
        });
      },
      readTextFile: async (params) => {
        const resolved = resolveWorkspacePath(state.cwd, params.path);
        let content: string;
        try {
          content = await fs.readFile(resolved, "utf8");
        } catch (err: any) {
          if (err?.code === "ENOENT") throw acp.RequestError.resourceNotFound(params.path);
          throw err;
        }

        const lineRaw = params.line ?? null;
        const limitRaw = params.limit ?? null;
        if (lineRaw == null && limitRaw == null) return { content };

        const start = Math.max(0, Number.isFinite(lineRaw) ? Math.max(0, (lineRaw as number) - 1) : 0);
        const limit = Number.isFinite(limitRaw) ? Math.max(0, limitRaw as number) : null;
        if (limit === 0) return { content: "" };

        const lines = content.split(/\r?\n/g);
        const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
        return { content: lines.slice(start, end).join("\n") };
      },
      writeTextFile: async (params) => {
        const resolved = resolveWorkspacePath(state.cwd, params.path);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, params.content ?? "", "utf8");
        return {};
      },
      createTerminal: async (params) => {
        const terminalId = randomUUID();
        const cwd = params.cwd?.trim() ? params.cwd.trim() : state.cwd;
        const resolvedCwd = resolveWorkspacePath(state.cwd, cwd);

        const env: Record<string, string> = {};
        for (const item of params.env ?? []) {
          if (!item?.name?.trim()) continue;
          env[item.name] = item.value ?? "";
        }

        const outputByteLimitRaw = params.outputByteLimit ?? null;
        const outputByteLimit = Number.isFinite(outputByteLimitRaw as number)
          ? Math.max(4_096, Math.min(64 * 1024 * 1024, outputByteLimitRaw as number))
          : 2 * 1024 * 1024;

        const command = [params.command, ...(params.args ?? [])].filter((x) => typeof x === "string" && x.length);
        if (!command.length) throw acp.RequestError.invalidParams({ command: "command is required" });

        const [rawCmd, ...rawArgs] = command;
        const spawnSpec = buildSpawnCommand(rawCmd, rawArgs);

        const proc = spawn(spawnSpec.cmd, spawnSpec.args, {
          cwd: resolvedCwd,
          env: Object.keys(env).length ? { ...process.env, ...env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let resolveExit: (value: TerminalExitStatus) => void;
        const exitPromise = new Promise<TerminalExitStatus>((resolve) => {
          resolveExit = resolve;
        });

        const term: ManagedTerminal = {
          sessionId: params.sessionId,
          output: "",
          truncated: false,
          outputByteLimit,
          exitStatus: null,
          exitPromise,
          kill: async () => {
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            await new Promise<void>((resolve) => {
              proc.once("exit", () => resolve());
              try {
                proc.kill();
              } catch {
                resolve();
              }
            });
          },
          release: async () => {
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            await new Promise<void>((resolve) => {
              proc.once("exit", () => resolve());
              try {
                proc.kill();
              } catch {
                resolve();
              }
            });
          },
        };

        const appendOutput = (chunk: string) => {
          if (!chunk) return;
          term.output += chunk;
          const trimmed = trimToByteLimit(term.output, term.outputByteLimit);
          term.output = trimmed.value;
          term.truncated = term.truncated || trimmed.truncated;
        };

        const pump = (stream: NodeJS.ReadableStream | null, label: "stdout" | "stderr") => {
          if (!stream) return;
          stream.setEncoding("utf8");
          stream.on("data", (chunk) => appendOutput(String(chunk ?? "")));
          stream.on("error", (err) => log("terminal stream error", { runId: state.runId, terminalId, label, err: String(err) }));
        };
        pump(proc.stdout, "stdout");
        pump(proc.stderr, "stderr");

        proc.on("exit", (code, signal) => {
          const exitStatus: TerminalExitStatus = { exitCode: code, signal };
          term.exitStatus = exitStatus;
          resolveExit(exitStatus);
        });
        proc.on("error", () => {
          const exitStatus: TerminalExitStatus = { exitCode: 1, signal: null };
          term.exitStatus = exitStatus;
          resolveExit(exitStatus);
        });

        state.terminals.set(terminalId, term);

        return { terminalId };
      },
      terminalOutput: async (params) => {
        const term = state.terminals.get(params.terminalId);
        if (!term) throw acp.RequestError.resourceNotFound(params.terminalId);
        return {
          output: term.output,
          truncated: term.truncated,
          exitStatus: term.exitStatus ? { exitCode: term.exitStatus.exitCode ?? null, signal: term.exitStatus.signal ?? null } : null,
        };
      },
      waitForTerminalExit: async (params) => {
        const term = state.terminals.get(params.terminalId);
        if (!term) throw acp.RequestError.resourceNotFound(params.terminalId);
        const status = term.exitStatus ?? (await term.exitPromise);
        return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
      },
      killTerminal: async (params) => {
        const term = state.terminals.get(params.terminalId);
        if (!term) throw acp.RequestError.resourceNotFound(params.terminalId);
        await term.kill();
        return {};
      },
      releaseTerminal: async (params) => {
        const term = state.terminals.get(params.terminalId);
        if (!term) throw acp.RequestError.resourceNotFound(params.terminalId);
        await term.release();
        state.terminals.delete(params.terminalId);
        return {};
      },
      extMethod: async (method, params) => {
        log("acp extMethod (unhandled)", { runId: state.runId, method, params });
        return {};
      },
      extNotification: async (method, params) => {
        log("acp extNotification (unhandled)", { runId: state.runId, method, params });
      },
    };
  }

  function createRunState(opts: { proxyId: string; runId: string; cwd: string }): RunTunnelState {
    let controller: ReadableStreamDefaultController<acp.AnyMessage> | null = null;
    const readable = new ReadableStream<acp.AnyMessage>({
      start(c) {
        controller = c;
      },
    });

    const writable = new WritableStream<acp.AnyMessage>({
      async write(message) {
        await deps.sendToAgent(opts.proxyId, { type: "acp_message", run_id: opts.runId, message });
      },
    });

    const stream: acp.Stream = { readable, writable };

    const state: RunTunnelState = {
      proxyId: opts.proxyId,
      runId: opts.runId,
      cwd: opts.cwd,
      opened: false,
      opening: null,
      openDeferred: null,
      stream,
      controller,
      conn: null as any,
      initialized: false,
      initResult: null,
      seenSessionIds: new Set<string>(),
      terminals: new Map<string, ManagedTerminal>(),
    };

    state.conn = new acp.ClientSideConnection(() => createClientImpl(state), stream);

    return state;
  }

  async function ensureOpen(opts: { proxyId: string; runId: string; cwd: string; init?: AcpOpenPayload }): Promise<RunTunnelState> {
    const existing = runStates.get(opts.runId);
    if (existing && existing.proxyId === opts.proxyId && existing.cwd === opts.cwd && existing.opened) return existing;

    const state =
      existing && existing.proxyId === opts.proxyId && existing.cwd === opts.cwd ? existing : createRunState(opts);
    runStates.set(opts.runId, state);

    if (state.opened) return state;
    if (state.opening) {
      await state.opening;
      return state;
    }

    const p = (async () => {
      const sandbox = await resolveSandboxOpenParams(opts.runId);
      await new Promise<void>((resolve, reject) => {
        state.openDeferred = { resolve, reject };
        void deps
          .sendToAgent(opts.proxyId, {
            type: "acp_open",
            run_id: opts.runId,
            cwd: opts.cwd,
            init: opts.init,
            instance_name: sandbox.instanceName,
            keepalive_ttl_seconds: sandbox.keepaliveTtlSeconds,
          })
          .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
      });
      state.opened = true;
    })();

    state.opening = p;
    try {
      await p;
    } finally {
      if (state.opening === p) state.opening = null;
      state.openDeferred = null;
    }

    return state;
  }

  async function ensureInitialized(state: RunTunnelState): Promise<acp.InitializeResponse> {
    if (state.initialized && state.initResult) return state.initResult;

    const init = await state.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "backend", title: "tuixiu backend", version: "0.0.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    state.initialized = true;
    state.initResult = init;
    return init;
  }

  async function withAuthRetry<T>(state: RunTunnelState, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      const methodId = state.initResult?.authMethods?.[0]?.id ?? "";
      if (!methodId) throw err;
      await state.conn.authenticate({ methodId });
      return await fn();
    }
  }

  async function ensureSessionForPrompt(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId?: string | null;
    context?: string;
    prompt: AcpContentBlock[];
    init?: AcpOpenPayload;
  }): Promise<{ state: RunTunnelState; sessionId: string; prompt: AcpContentBlock[] }> {
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd: opts.cwd, init: opts.init });
    await ensureInitialized(state);

    const promptCapabilities = getPromptCapabilities(state.initResult);
    let sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    let promptBlocks = opts.prompt;

    if (!sessionId) {
      const created = await withAuthRetry(state, () => state.conn.newSession({ cwd: opts.cwd, mcpServers: [] }));
      sessionId = created.sessionId;
      state.seenSessionIds.add(sessionId);
      await deps.prisma.run.update({ where: { id: opts.runId }, data: { acpSessionId: sessionId } as any }).catch(() => {});
      await updateSessionState(opts.runId, {
        sessionId,
        activity: "busy",
        inFlight: 1,
        updatedAt: new Date().toISOString(),
        currentModeId: created.modes?.currentModeId ?? null,
        currentModelId: created.models?.currentModelId ?? null,
        lastStopReason: null,
        note: "session_created",
      });
      promptBlocks = composePromptWithContext(opts.context, promptBlocks, promptCapabilities);
      return { state, sessionId, prompt: promptBlocks };
    }

    // 仅当本进程没见过该 session 时，尝试 load 历史会话。
    if (!state.seenSessionIds.has(sessionId)) {
      state.seenSessionIds.add(sessionId);
      const canLoad = !!state.initResult?.agentCapabilities?.loadSession;
      if (canLoad) {
        await updateSessionState(opts.runId, {
          sessionId,
          activity: "loading",
          updatedAt: new Date().toISOString(),
          note: "load_start",
        });
        const loaded = await withAuthRetry(state, () => state.conn.loadSession({ sessionId, cwd: opts.cwd, mcpServers: [] }))
          .then((res) => res)
          .catch(() => null);
        if (loaded) {
          await updateSessionState(opts.runId, {
            sessionId,
            activity: "idle",
            updatedAt: new Date().toISOString(),
            currentModeId: loaded.modes?.currentModeId ?? null,
            currentModelId: loaded.models?.currentModelId ?? null,
            note: "load_ok",
          });
        } else {
          await updateSessionState(opts.runId, {
            sessionId,
            activity: "unknown",
            updatedAt: new Date().toISOString(),
            note: "load_failed",
          });
        }
      }
    }

    return { state, sessionId, prompt: promptBlocks };
  }

  async function persistPromptResult(runId: string, stopReason: string) {
    await enqueueRunTask(runId, async () => {
      await flushRunChunkBuffer(runId);
      const createdEvent = await deps.prisma.event.create({
        data: {
          id: uuidv7(),
          runId,
          source: "acp",
          type: "acp.update.received",
          payload: { type: "prompt_result", stopReason } as any,
        },
      });
      deps.broadcastToClients?.({ type: "event_added", run_id: runId, event: createdEvent });
    });
  }

  async function finalizeRunIfRunning(runId: string) {
    const run = await deps.prisma.run.findUnique({
      where: { id: runId },
      select: { id: true, status: true, issueId: true, agentId: true, taskId: true, stepId: true, metadata: true },
    });
    if (!run || (run as any).status !== "running") return;

    const meta = (run as any).metadata;
    const metaObj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as any) : null;
    const flags = metaObj && metaObj.flags && typeof metaObj.flags === "object" && !Array.isArray(metaObj.flags) ? (metaObj.flags as any) : null;
    const suppressIssueStatusUpdate = Boolean(metaObj?.suppressIssueStatusUpdate ?? flags?.suppressIssueStatusUpdate);
    const suppressPmAutoAdvance = Boolean(metaObj?.suppressPmAutoAdvance ?? flags?.suppressPmAutoAdvance);

    await deps.prisma.run.update({ where: { id: runId }, data: { status: "completed", completedAt: new Date() } as any }).catch(() => {});

    const advanced = await advanceTaskFromRunTerminal({ prisma: deps.prisma }, runId, "completed").catch(() => ({ handled: false }));
    if (advanced.handled && (run as any).taskId) {
      deps.broadcastToClients?.({
        type: "task_updated",
        issue_id: (run as any).issueId,
        task_id: (run as any).taskId,
        step_id: (run as any).stepId ?? undefined,
        run_id: (run as any).id,
      });
    }

    if (!advanced.handled && !suppressIssueStatusUpdate) {
      await deps.prisma.issue.updateMany({ where: { id: (run as any).issueId, status: "running" }, data: { status: "reviewing" } }).catch(() => {});
    }

    if ((run as any).agentId) {
      await deps.prisma.agent.update({ where: { id: (run as any).agentId }, data: { currentLoad: { decrement: 1 } } }).catch(() => {});
    }

    if (!suppressPmAutoAdvance) {
      triggerPmAutoAdvance({ prisma: deps.prisma }, { runId, issueId: (run as any).issueId, trigger: "run_completed" });
    }
  }

  async function promptRun(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId?: string | null;
    context?: string;
    prompt: AcpContentBlock[];
    init?: AcpOpenPayload;
  }): Promise<{ sessionId: string; stopReason: string }> {
    const { state, sessionId, prompt } = await ensureSessionForPrompt(opts);

    await updateSessionState(opts.runId, {
      sessionId,
      activity: "busy",
      inFlight: 1,
      updatedAt: new Date().toISOString(),
      note: "prompt_start",
    });

    let res: acp.PromptResponse;
    try {
      const promptCapabilities = getPromptCapabilities(state.initResult);
      assertPromptBlocksSupported(prompt, promptCapabilities);
      res = await withAuthRetry(state, () => state.conn.prompt({ sessionId, prompt }));
    } catch (err) {
      if (shouldRecreateSession(err)) {
        const created = await withAuthRetry(state, () => state.conn.newSession({ cwd: opts.cwd, mcpServers: [] }));
        const newSessionId = created.sessionId;
        state.seenSessionIds.add(newSessionId);
        await deps.prisma.run.update({ where: { id: opts.runId }, data: { acpSessionId: newSessionId } as any }).catch(() => {});
        await updateSessionState(opts.runId, {
          sessionId: newSessionId,
          activity: "busy",
          inFlight: 1,
          updatedAt: new Date().toISOString(),
          currentModeId: created.modes?.currentModeId ?? null,
          currentModelId: created.models?.currentModelId ?? null,
          lastStopReason: null,
          note: "session_recreated",
        });

        const promptCapabilities = getPromptCapabilities(state.initResult);
        const replay = composePromptWithContext(opts.context, opts.prompt, promptCapabilities);
        assertPromptBlocksSupported(replay, promptCapabilities);
        res = await withAuthRetry(state, () =>
          state.conn.prompt({ sessionId: newSessionId, prompt: replay }),
        );
        await updateSessionState(opts.runId, {
          sessionId: newSessionId,
          activity: "idle",
          inFlight: 0,
          updatedAt: new Date().toISOString(),
          lastStopReason: res.stopReason,
          note: "prompt_end",
        });
        await persistPromptResult(opts.runId, res.stopReason);
        await finalizeRunIfRunning(opts.runId);
        return { sessionId: newSessionId, stopReason: res.stopReason };
      }
      throw err;
    }

    await updateSessionState(opts.runId, {
      sessionId,
      activity: "idle",
      inFlight: 0,
      updatedAt: new Date().toISOString(),
      lastStopReason: res.stopReason,
      note: "prompt_end",
    });

    await persistPromptResult(opts.runId, res.stopReason);
    await finalizeRunIfRunning(opts.runId);
    return { sessionId, stopReason: res.stopReason };
  }

  async function cancelSession(opts: { proxyId: string; runId: string; cwd: string; sessionId: string }) {
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd: opts.cwd });
    await ensureInitialized(state);
    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      activity: "cancel_requested",
      updatedAt: new Date().toISOString(),
      note: "cancel",
    });
    await state.conn.cancel({ sessionId: opts.sessionId });
  }

  async function setSessionMode(opts: { proxyId: string; runId: string; cwd: string; sessionId: string; modeId: string }) {
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd: opts.cwd });
    await ensureInitialized(state);
    await withAuthRetry(state, () => state.conn.setSessionMode({ sessionId: opts.sessionId, modeId: opts.modeId }));
    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      currentModeId: opts.modeId,
      updatedAt: new Date().toISOString(),
      note: "mode_set",
    });
  }

  async function setSessionModel(opts: { proxyId: string; runId: string; cwd: string; sessionId: string; modelId: string }) {
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd: opts.cwd });
    await ensureInitialized(state);
    await withAuthRetry(state, () => state.conn.setSessionModel({ sessionId: opts.sessionId, modelId: opts.modelId }));
    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      currentModelId: opts.modelId,
      updatedAt: new Date().toISOString(),
      note: "model_set",
    });
  }

  function handleAcpOpened(proxyId: string, payload: any) {
    const runId = String(payload?.run_id ?? "").trim();
    if (!runId) return;
    const ok = payload?.ok === true;
    const errText = typeof payload?.error === "string" ? payload.error : ok ? "" : "unknown";
    const state = runStates.get(runId);
    if (!state || state.proxyId !== proxyId) return;
    if (!state.openDeferred) return;
    if (ok) {
      state.openDeferred.resolve();
    } else {
      state.openDeferred.reject(new Error(`acp_open failed: ${errText}`));
    }
  }

  function handleAcpMessage(proxyId: string, payload: any) {
    const runId = String(payload?.run_id ?? "").trim();
    if (!runId) return;
    const state = runStates.get(runId);
    if (!state || state.proxyId !== proxyId) return;
    if (!state.controller) return;
    const message = payload?.message;
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;
    try {
      state.controller.enqueue(message as any);
    } catch (err) {
      log("acp enqueue failed", { runId, err: String(err) });
    }
  }

  function handleProxyDisconnected(proxyId: string) {
    for (const [runId, state] of runStates) {
      if (state.proxyId !== proxyId) continue;
      runStates.delete(runId);
      try {
        state.controller?.close();
      } catch {
        // ignore
      }
      state.openDeferred?.reject(new Error("proxy disconnected"));
    }
  }

  return {
    promptRun,
    cancelSession,
    setSessionMode,
    setSessionModel,
    __testing: {
      runStates,
      chunkBuffersByRun,
      bufferChunkSegment,
      flushRunChunkBuffer,
      persistSessionUpdate,
    },
    gatewayHandlers: {
      handleAcpOpened,
      handleAcpMessage,
      handleProxyDisconnected,
    },
  };
}

export type AcpTunnel = ReturnType<typeof createAcpTunnel>;
