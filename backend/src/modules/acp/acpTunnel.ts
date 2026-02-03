import type { PrismaDeps, SendToAgent } from "../../db.js";
import { uuidv7 } from "../../utils/uuid.js";
import {
  DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
  deriveSandboxInstanceName,
} from "../../utils/sandbox.js";
import { advanceTaskFromRunTerminal } from "../workflow/taskProgress.js";
import { triggerPmAutoAdvance } from "../pm/pmAutoAdvance.js";
import type { AcpContentBlock } from "./acpContent.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type AcpOpenPayload = {
  script: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
  agentInputs?: unknown;
};

type OpenDeferred = {
  resolve: () => void;
  reject: (err: Error) => void;
};

type PromptDeferred = {
  resolve: (value: { sessionId: string; stopReason: string }) => void;
  reject: (err: Error) => void;
};

type ControlDeferred = {
  resolve: () => void;
  reject: (err: Error) => void;
};

type RunTunnelState = {
  proxyId: string;
  runId: string;
  cwd: string;
  opened: boolean;
  opening: Promise<void> | null;
  openDeferred: OpenDeferred | null;
  promptDeferredById: Map<string, PromptDeferred>;
  controlDeferredById: Map<string, ControlDeferred>;
  instanceName: string | null;
  keepaliveTtlSeconds: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CHUNK_SESSION_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "user_message_chunk",
]);
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
  sandboxGitPush?: (opts: { run: any; branch: string; project: any }) => Promise<void>;
  broadcastToClients?: (payload: unknown) => void;
  log?: Logger;
}) {
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

  async function resolveSandboxOpenParams(
    runId: string,
  ): Promise<{ instanceName: string; keepaliveTtlSeconds: number }> {
    const run = await deps.prisma.run
      .findUnique({
        where: { id: runId },
        select: { sandboxInstanceName: true, keepaliveTtlSeconds: true },
      } as any)
      .catch(() => null);

    const instanceNameRaw =
      run && typeof (run as any).sandboxInstanceName === "string"
        ? String((run as any).sandboxInstanceName)
        : "";
    const instanceName = instanceNameRaw.trim()
      ? instanceNameRaw.trim()
      : deriveSandboxInstanceName(runId);

    const ttlRaw =
      run && typeof (run as any).keepaliveTtlSeconds === "number"
        ? Number((run as any).keepaliveTtlSeconds)
        : NaN;
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
    const buf: RunChunkBuffer = chunkBuffersByRun.get(runId) ?? {
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

  async function persistSessionUpdate(runId: string, sessionId: string, update: any) {
    const sessionUpdate =
      typeof update?.sessionUpdate === "string" ? String(update.sessionUpdate) : "";
    const content = update?.content;

    if (
      CHUNK_SESSION_UPDATES.has(sessionUpdate) &&
      content?.type === "text" &&
      typeof content.text === "string" &&
      content.text
    ) {
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
    const run = await deps.prisma.run
      .findUnique({ where: { id: runId }, select: { metadata: true, acpSessionId: true } })
      .catch(() => null);
    const prev = run && isRecord(run.metadata) ? (run.metadata as Record<string, unknown>) : {};
    const existing = isRecord((prev as any).acpSessionState)
      ? ((prev as any).acpSessionState as Record<string, unknown>)
      : {};
    const next = { ...existing, ...patch };
    await deps.prisma.run
      .update({
        where: { id: runId },
        data: { metadata: { ...prev, acpSessionState: next } as any },
      })
      .catch(() => {});
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
      select: {
        id: true,
        status: true,
        issueId: true,
        agentId: true,
        taskId: true,
        stepId: true,
        metadata: true,
      },
    });
    if (!run || (run as any).status !== "running") return;

    const meta = (run as any).metadata;
    const metaObj = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as any) : null;
    const flags =
      metaObj && metaObj.flags && typeof metaObj.flags === "object" && !Array.isArray(metaObj.flags)
        ? (metaObj.flags as any)
        : null;
    const suppressIssueStatusUpdate = Boolean(
      metaObj?.suppressIssueStatusUpdate ?? flags?.suppressIssueStatusUpdate,
    );
    const suppressPmAutoAdvance = Boolean(
      metaObj?.suppressPmAutoAdvance ?? flags?.suppressPmAutoAdvance,
    );

    await deps.prisma.run
      .update({
        where: { id: runId },
        data: { status: "completed", completedAt: new Date() } as any,
      })
      .catch(() => {});

    const advanced = await advanceTaskFromRunTerminal(
      { prisma: deps.prisma },
      runId,
      "completed",
    ).catch(() => ({ handled: false }));
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
      await deps.prisma.issue
        .updateMany({
          where: { id: (run as any).issueId, status: "running" },
          data: { status: "reviewing" },
        })
        .catch(() => {});
    }

    if ((run as any).agentId) {
      await deps.prisma.agent
        .update({ where: { id: (run as any).agentId }, data: { currentLoad: { decrement: 1 } } })
        .catch(() => {});
    }

    if (!suppressPmAutoAdvance) {
      triggerPmAutoAdvance(
        { prisma: deps.prisma, sandboxGitPush: deps.sandboxGitPush },
        { runId, issueId: (run as any).issueId, trigger: "run_completed" },
      );
    }
  }

  function createRunState(opts: { proxyId: string; runId: string; cwd: string }): RunTunnelState {
    return {
      proxyId: opts.proxyId,
      runId: opts.runId,
      cwd: opts.cwd,
      opened: false,
      opening: null,
      openDeferred: null,
      promptDeferredById: new Map(),
      controlDeferredById: new Map(),
      instanceName: null,
      keepaliveTtlSeconds: null,
    };
  }

  async function ensureOpen(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    init?: AcpOpenPayload;
  }): Promise<RunTunnelState> {
    const existing = runStates.get(opts.runId);
    if (
      existing &&
      existing.proxyId === opts.proxyId &&
      existing.cwd === opts.cwd &&
      existing.opened
    )
      return existing;

    const state =
      existing && existing.proxyId === opts.proxyId && existing.cwd === opts.cwd
        ? existing
        : createRunState(opts);
    runStates.set(opts.runId, state);

    if (state.opened) return state;
    if (state.opening) {
      await state.opening;
      return state;
    }

    const p = (async () => {
      const sandbox = await resolveSandboxOpenParams(opts.runId);
      state.instanceName = sandbox.instanceName;
      state.keepaliveTtlSeconds = sandbox.keepaliveTtlSeconds;
      await new Promise<void>((resolve, reject) => {
        const baseTimeoutMsRaw = Number(process.env.ACP_OPEN_TIMEOUT_MS ?? "300000");
        const baseTimeoutMs =
          Number.isFinite(baseTimeoutMsRaw) && baseTimeoutMsRaw > 0 ? baseTimeoutMsRaw : 300_000;

        const initScript = opts.init?.script?.trim() ?? "";
        const initTimeoutSecondsRaw = opts.init?.timeout_seconds ?? null;
        const initTimeoutSeconds = Number.isFinite(initTimeoutSecondsRaw as number)
          ? Math.max(1, Math.min(3600, Number(initTimeoutSecondsRaw)))
          : 300;

        const timeoutMs = initScript
          ? Math.max(baseTimeoutMs, initTimeoutSeconds * 1000 + 10_000)
          : baseTimeoutMs;

        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`acp_open timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        (timer as any).unref?.();

        state.openDeferred = {
          resolve: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          },
        };

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

  function promptTimeoutMsFromEnv(): number {
    const raw = Number(process.env.ACP_PROMPT_TIMEOUT_MS ?? "3600000");
    if (Number.isFinite(raw) && raw > 0) return Math.min(24 * 3600 * 1000, Math.max(5_000, raw));
    return 3600_000;
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
    let init = opts.init;
    if (init) {
      const runStatus = await deps.prisma.run
        .findUnique({
          where: { id: opts.runId },
          select: { sandboxStatus: true },
        } as any)
        .catch(() => null);
      const sandboxStatus =
        runStatus && typeof (runStatus as any).sandboxStatus === "string"
          ? String((runStatus as any).sandboxStatus)
          : "";
      if (sandboxStatus && sandboxStatus !== "missing" && sandboxStatus !== "creating") {
        init = undefined;
      }
    }

    const cwd = "/workspace";
    const state = await ensureOpen({
      proxyId: opts.proxyId,
      runId: opts.runId,
      cwd,
      init,
    });

    const promptId = uuidv7();
    const timeoutMs = promptTimeoutMsFromEnv();

    const wait = new Promise<{ sessionId: string; stopReason: string }>((resolve, reject) => {
      state.promptDeferredById.set(promptId, { resolve, reject });
      const timer = setTimeout(() => {
        if (!state.promptDeferredById.has(promptId)) return;
        state.promptDeferredById.delete(promptId);
        reject(new Error(`prompt timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      (timer as any).unref?.();
    });

    const sessionIdHint = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
    if (sessionIdHint) {
      await updateSessionState(opts.runId, {
        sessionId: sessionIdHint,
        activity: "busy",
        inFlight: 1,
        updatedAt: new Date().toISOString(),
        note: "prompt_start",
      });
    }

    await deps.sendToAgent(opts.proxyId, {
      type: "prompt_send",
      run_id: opts.runId,
      prompt_id: promptId,
      cwd,
      session_id: sessionIdHint || null,
      instance_name: state.instanceName ?? deriveSandboxInstanceName(opts.runId),
      keepalive_ttl_seconds:
        state.keepaliveTtlSeconds ?? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
      context: typeof opts.context === "string" ? opts.context : undefined,
      prompt: opts.prompt,
      timeout_ms: timeoutMs,
    });

    const res = await wait;

    await deps.prisma.run
      .update({ where: { id: opts.runId }, data: { acpSessionId: res.sessionId } as any })
      .catch(() => {});

    await updateSessionState(opts.runId, {
      sessionId: res.sessionId,
      activity: "idle",
      inFlight: 0,
      updatedAt: new Date().toISOString(),
      lastStopReason: res.stopReason,
      note: "prompt_end",
    });

    await persistPromptResult(opts.runId, res.stopReason);
    await finalizeRunIfRunning(opts.runId);
    return res;
  }

  async function cancelSession(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId: string;
  }) {
    const cwd = "/workspace";
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd });

    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      activity: "cancel_requested",
      updatedAt: new Date().toISOString(),
      note: "cancel",
    });

    const controlId = uuidv7();
    const wait = new Promise<void>((resolve, reject) => {
      state.controlDeferredById.set(controlId, { resolve, reject });
      const timer = setTimeout(() => {
        if (!state.controlDeferredById.has(controlId)) return;
        state.controlDeferredById.delete(controlId);
        reject(new Error("session_cancel timeout"));
      }, 60_000);
      (timer as any).unref?.();
    });

    await deps.sendToAgent(opts.proxyId, {
      type: "session_cancel",
      run_id: opts.runId,
      control_id: controlId,
      session_id: opts.sessionId,
      instance_name: state.instanceName ?? deriveSandboxInstanceName(opts.runId),
      keepalive_ttl_seconds:
        state.keepaliveTtlSeconds ?? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
    });
    await wait;
  }

  async function setSessionMode(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId: string;
    modeId: string;
  }) {
    const cwd = "/workspace";
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd });

    const controlId = uuidv7();
    const wait = new Promise<void>((resolve, reject) => {
      state.controlDeferredById.set(controlId, { resolve, reject });
      const timer = setTimeout(() => {
        if (!state.controlDeferredById.has(controlId)) return;
        state.controlDeferredById.delete(controlId);
        reject(new Error("session_set_mode timeout"));
      }, 60_000);
      (timer as any).unref?.();
    });

    await deps.sendToAgent(opts.proxyId, {
      type: "session_set_mode",
      run_id: opts.runId,
      control_id: controlId,
      session_id: opts.sessionId,
      mode_id: opts.modeId,
      instance_name: state.instanceName ?? deriveSandboxInstanceName(opts.runId),
      keepalive_ttl_seconds:
        state.keepaliveTtlSeconds ?? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
    });
    await wait;

    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      currentModeId: opts.modeId,
      updatedAt: new Date().toISOString(),
      note: "mode_set",
    });
  }

  async function setSessionModel(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId: string;
    modelId: string;
  }) {
    const cwd = "/workspace";
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd });

    const controlId = uuidv7();
    const wait = new Promise<void>((resolve, reject) => {
      state.controlDeferredById.set(controlId, { resolve, reject });
      const timer = setTimeout(() => {
        if (!state.controlDeferredById.has(controlId)) return;
        state.controlDeferredById.delete(controlId);
        reject(new Error("session_set_model timeout"));
      }, 60_000);
      (timer as any).unref?.();
    });

    await deps.sendToAgent(opts.proxyId, {
      type: "session_set_model",
      run_id: opts.runId,
      control_id: controlId,
      session_id: opts.sessionId,
      model_id: opts.modelId,
      instance_name: state.instanceName ?? deriveSandboxInstanceName(opts.runId),
      keepalive_ttl_seconds:
        state.keepaliveTtlSeconds ?? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
    });
    await wait;

    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      currentModelId: opts.modelId,
      updatedAt: new Date().toISOString(),
      note: "model_set",
    });
  }

  async function setSessionConfigOption(opts: {
    proxyId: string;
    runId: string;
    cwd: string;
    sessionId: string;
    configId: string;
    value: unknown;
  }) {
    const cwd = "/workspace";
    const state = await ensureOpen({ proxyId: opts.proxyId, runId: opts.runId, cwd });

    const controlId = uuidv7();
    const wait = new Promise<void>((resolve, reject) => {
      state.controlDeferredById.set(controlId, { resolve, reject });
      const timer = setTimeout(() => {
        if (!state.controlDeferredById.has(controlId)) return;
        state.controlDeferredById.delete(controlId);
        reject(new Error("session_set_config_option timeout"));
      }, 60_000);
      (timer as any).unref?.();
    });

    await deps.sendToAgent(opts.proxyId, {
      type: "session_set_config_option",
      run_id: opts.runId,
      control_id: controlId,
      session_id: opts.sessionId,
      config_id: opts.configId,
      value: opts.value,
      instance_name: state.instanceName ?? deriveSandboxInstanceName(opts.runId),
      keepalive_ttl_seconds:
        state.keepaliveTtlSeconds ?? DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS,
    });
    await wait;

    await updateSessionState(opts.runId, {
      sessionId: opts.sessionId,
      updatedAt: new Date().toISOString(),
      note: `config_option_set:${opts.configId}`,
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
    if (ok) state.openDeferred.resolve();
    else state.openDeferred.reject(new Error(`acp_open failed: ${errText}`));
  }

  function handlePromptUpdate(proxyId: string, payload: any) {
    const runId = String(payload?.run_id ?? "").trim();
    if (!runId) return;

    const sessionId =
      typeof payload?.session_id === "string" && payload.session_id.trim()
        ? payload.session_id.trim()
        : "";
    const update = payload?.update;
    if (!sessionId || !isRecord(update)) return;

    void enqueueRunTask(runId, async () => {
      const state = runStates.get(runId);
      if (state) {
        if (state.proxyId !== proxyId) return;
      } else {
        // 兼容：后端重启/断线后 runStates 会丢失，但代理仍可能继续推送 session/update。
        // 这时用 DB 校验 run 归属后继续持久化（否则 config_option_update 等关键事件会“凭空消失”）。
        const run = await deps.prisma.run
          .findUnique({
            where: { id: runId },
            select: { agent: { select: { proxyId: true } } },
          } as any)
          .catch(() => null);
        const expectedProxyId =
          run && (run as any).agent && typeof (run as any).agent.proxyId === "string"
            ? String((run as any).agent.proxyId)
            : "";
        if (!expectedProxyId || expectedProxyId !== proxyId) return;

        const sessionUpdate =
          typeof (update as any).sessionUpdate === "string"
            ? String((update as any).sessionUpdate)
            : "";
        if (sessionUpdate === "config_option_update" && deps.log) {
          deps.log("acp prompt_update persisted without runState (post-restart)", {
            runId,
            proxyId,
            sessionId,
          });
        }
      }

      await persistSessionUpdate(runId, sessionId, update);

      const sessionUpdate =
        typeof (update as any).sessionUpdate === "string"
          ? String((update as any).sessionUpdate)
          : "";
      if (sessionUpdate === "current_mode_update") {
        const modeId =
          typeof (update as any).modeId === "string"
            ? String((update as any).modeId)
            : typeof (update as any).currentModeId === "string"
              ? String((update as any).currentModeId)
              : "";
        if (modeId) {
          await updateSessionState(runId, {
            sessionId,
            currentModeId: modeId,
            updatedAt: new Date().toISOString(),
          });
        }
      }

      if (sessionUpdate === "config_option_update") {
        const configOptions = Array.isArray((update as any).configOptions)
          ? ((update as any).configOptions as any[])
          : null;
        if (configOptions) {
          const modeOpt = configOptions.find(
            (x) => x && typeof x === "object" && (x as any).id === "mode",
          ) as any;
          const modelOpt = configOptions.find(
            (x) => x && typeof x === "object" && (x as any).id === "model",
          ) as any;

          const modeValue = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : "";
          const modelValue =
            typeof modelOpt?.currentValue === "string" ? modelOpt.currentValue : "";

          await updateSessionState(runId, {
            sessionId,
            // 兼容：部分 Agent 用 configOptions 表达“approval preset / mode”和“model”。
            ...(modeValue ? { currentModeId: modeValue } : {}),
            ...(modelValue ? { currentModelId: modelValue } : {}),
            configOptions,
            updatedAt: new Date().toISOString(),
            note: "config_option_update",
          });
        }
      }
    });
  }

  function handlePromptResult(proxyId: string, payload: any) {
    const runId = String(payload?.run_id ?? "").trim();
    const promptId = String(payload?.prompt_id ?? "").trim();
    if (!runId || !promptId) return;
    const state = runStates.get(runId);
    if (!state || state.proxyId !== proxyId) return;

    const deferred = state.promptDeferredById.get(promptId);
    if (!deferred) return;
    state.promptDeferredById.delete(promptId);

    const ok = payload?.ok === true;
    if (!ok) {
      const errText = typeof payload?.error === "string" ? payload.error : "prompt_failed";
      deferred.reject(new Error(errText));
      return;
    }

    const sessionId = typeof payload?.session_id === "string" ? String(payload.session_id) : "";
    const stopReason = typeof payload?.stop_reason === "string" ? String(payload.stop_reason) : "";
    if (!sessionId || !stopReason) {
      deferred.reject(new Error("prompt_result 缺少 session_id/stop_reason"));
      return;
    }

    deferred.resolve({ sessionId, stopReason });
  }

  function handleSessionControlResult(proxyId: string, payload: any) {
    const runId = String(payload?.run_id ?? "").trim();
    const controlId = String(payload?.control_id ?? "").trim();
    if (!runId || !controlId) return;
    const state = runStates.get(runId);
    if (!state || state.proxyId !== proxyId) return;

    const deferred = state.controlDeferredById.get(controlId);
    if (!deferred) return;
    state.controlDeferredById.delete(controlId);

    const ok = payload?.ok === true;
    if (ok) deferred.resolve();
    else
      deferred.reject(
        new Error(typeof payload?.error === "string" ? payload.error : "control_failed"),
      );
  }

  function handleProxyDisconnected(proxyId: string) {
    for (const [runId, state] of runStates) {
      if (state.proxyId !== proxyId) continue;
      runStates.delete(runId);
      state.openDeferred?.reject(new Error("proxy disconnected"));
      for (const d of state.promptDeferredById.values()) d.reject(new Error("proxy disconnected"));
      state.promptDeferredById.clear();
      for (const d of state.controlDeferredById.values()) d.reject(new Error("proxy disconnected"));
      state.controlDeferredById.clear();
    }
  }

  return {
    promptRun,
    cancelSession,
    setSessionMode,
    setSessionModel,
    setSessionConfigOption,
    __testing: {
      runStates,
      chunkBuffersByRun,
      bufferChunkSegment,
      flushRunChunkBuffer,
      persistSessionUpdate,
    },
    gatewayHandlers: {
      handleAcpOpened,
      handlePromptUpdate,
      handlePromptResult,
      handleSessionControlResult,
      handleProxyDisconnected,
    },
  };
}

export type AcpTunnel = ReturnType<typeof createAcpTunnel>;
