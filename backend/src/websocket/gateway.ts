import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { PrismaDeps } from "../deps.js";
import type { AcpTunnel } from "../services/acpTunnel.js";
import { buildContextFromRun } from "../services/runContext.js";
import { triggerPmAutoAdvance } from "../services/pm/pmAutoAdvance.js";
import { triggerTaskAutoAdvance } from "../services/taskAutoAdvance.js";
import { advanceTaskFromRunTerminal } from "../services/taskProgress.js";
import { uuidv7 } from "../utils/uuid.js";
import { deriveSandboxInstanceName } from "../utils/sandbox.js";

type AgentRegisterMessage = {
  type: "register_agent";
  agent: {
    id: string; // proxyId
    name: string;
    capabilities?: unknown;
    max_concurrent?: number;
  };
};

type AgentHeartbeatMessage = {
  type: "heartbeat";
  agent_id: string; // proxyId
  timestamp?: string;
};

type AgentUpdateMessage = {
  type: "agent_update";
  run_id: string;
  content: unknown;
};

type AcpOpenedMessage = {
  type: "acp_opened";
  run_id: string;
  ok: boolean;
  error?: string;
};

type AcpMessageMessage = {
  type: "acp_message";
  run_id: string;
  message: unknown;
};

type BranchCreatedMessage = {
  type: "branch_created";
  run_id: string;
  branch: string;
};

type AcpExitMessage = {
  type: "acp_exit";
  run_id: string;
  instance_name?: string;
  code?: number;
  signal?: string | null;
};

type SandboxInventoryMessage = {
  type: "sandbox_inventory";
  inventory_id: string;
  provider?: string;
  runtime?: string;
  captured_at?: string;
  instances?: Array<{
    instance_name: string;
    run_id?: string | null;
    status?: string;
    created_at?: string;
    last_seen_at?: string;
    last_error?: string | null;
    provider?: string;
    runtime?: string;
  }>;
};

type AnyAgentMessage =
  | AgentRegisterMessage
  | AgentHeartbeatMessage
  | AgentUpdateMessage
  | AcpOpenedMessage
  | AcpMessageMessage
  | BranchCreatedMessage
  | AcpExitMessage
  | SandboxInventoryMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeSandboxStatus(value: unknown): "creating" | "running" | "stopped" | "missing" | "error" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "creating" || v === "created" || v === "starting") return "creating";
  if (v === "running") return "running";
  if (v === "stopped" || v === "exited" || v === "dead") return "stopped";
  if (v === "missing" || v === "not_found") return "missing";
  if (v === "error" || v === "failed") return "error";
  return null;
}

export function createWebSocketGateway(deps: { prisma: PrismaDeps }) {
  const agentConnections = new Map<string, WebSocket>();
  const clientConnections = new Set<WebSocket>();
  let acpTunnel: AcpTunnel | null = null;
  let acpTunnelHandlers:
    | null
    | {
        handleAcpOpened: (proxyId: string, payload: unknown) => void;
        handleAcpMessage: (proxyId: string, payload: unknown) => void;
        handleProxyDisconnected?: (proxyId: string) => void;
      } = null;

  async function resumeRunningRuns(opts: { proxyId: string; agentId: string; logError: (err: unknown) => void }) {
    if (!acpTunnel) return;

    const runs = await deps.prisma.run.findMany({
      where: { agentId: opts.agentId, status: "running" },
      include: { issue: true, artifacts: true },
      orderBy: { startedAt: "asc" }
    });

    for (const run of runs as any[]) {
      try {
        const events = await deps.prisma.event.findMany({
          where: { runId: run.id },
          orderBy: { timestamp: "desc" },
          take: 200
        });
        const context = buildContextFromRun({
          run,
          issue: run.issue,
          events
        });

        const cwd = String(run.workspacePath ?? "").trim();
        if (!cwd) continue;

        await acpTunnel.promptRun({
          proxyId: opts.proxyId,
          runId: run.id,
          cwd,
          sessionId: run.acpSessionId ?? null,
          context,
          prompt: [
            {
              type: "text",
              text: "（系统）检测到 acp-proxy 断线重连/重启。请在当前工作目录(该 Run 的 workspace)检查进度（git status/最近改动/已有 commit）后继续完成任务；若你判断任务已完成，请输出总结并结束。",
            },
          ],
        });
      } catch (err) {
        opts.logError(err);
      }
    }
  }

  function broadcastToClients(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const ws of clientConnections) {
      ws.send(data);
    }
  }

  async function sendToAgent(proxyId: string, payload: unknown) {
    const ws = agentConnections.get(proxyId);
    if (!ws) throw new Error(`Agent ${proxyId} not connected`);
    ws.send(JSON.stringify(payload));
  }

  const CHUNK_SESSION_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);
  const CHUNK_FLUSH_INTERVAL_MS = 800;
  const CHUNK_MAX_BUFFER_CHARS = 16_000;
  type BufferedChunkSegment = {
    session: string | null;
    sessionUpdate: string;
    text: string;
  };
  type RunChunkBuffer = {
    segments: BufferedChunkSegment[];
    totalChars: number;
    timer: NodeJS.Timeout | null;
  };
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

  function extractChunkSegment(content: unknown): BufferedChunkSegment | null {
    if (!isRecord(content)) return null;
    if (content.type !== "session_update") return null;

    const update = content.update;
    if (!isRecord(update)) return null;
    const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (!CHUNK_SESSION_UPDATES.has(sessionUpdate)) return null;

    const updContent = update.content;
    if (!isRecord(updContent)) return null;
    if (updContent.type !== "text") return null;
    const text = typeof updContent.text === "string" ? updContent.text : "";
    if (!text) return null;

    const session = typeof content.session === "string" && content.session ? content.session : null;
    return { session, sessionUpdate, text };
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
            session: seg.session ?? undefined,
            update: {
              sessionUpdate: seg.sessionUpdate,
              content: { type: "text", text: seg.text }
            }
          } as any
        }
      });
      broadcastToClients({ type: "event_added", run_id: runId, event: createdEvent });
    }
  }

  async function bufferChunkSegment(runId: string, seg: BufferedChunkSegment, logError: (err: unknown) => void): Promise<void> {
    const existing = chunkBuffersByRun.get(runId);
    const buf: RunChunkBuffer =
      existing ??
      {
        segments: [],
        totalChars: 0,
        timer: null
      };

    const last = buf.segments.length ? buf.segments[buf.segments.length - 1] : null;
    if (last && last.session === seg.session && last.sessionUpdate === seg.sessionUpdate) {
      last.text += seg.text;
    } else {
      buf.segments.push(seg);
    }
    buf.totalChars += seg.text.length;
    chunkBuffersByRun.set(runId, buf);

    if (buf.totalChars >= CHUNK_MAX_BUFFER_CHARS) {
      await flushRunChunkBuffer(runId);
      return;
    }

    if (!buf.timer) {
      buf.timer = setTimeout(() => {
        void enqueueRunTask(runId, () => flushRunChunkBuffer(runId)).catch(logError);
      }, CHUNK_FLUSH_INTERVAL_MS);
      buf.timer.unref?.();
    }
  }

  function handleAgentConnection(socket: WebSocket, logError: (err: unknown) => void) {
    let proxyId: string | null = null;

    socket.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as AnyAgentMessage;

        if (message.type === "register_agent") {
          proxyId = message.agent.id;
          agentConnections.set(proxyId, socket);

          const agentRecord = await deps.prisma.agent.upsert({
            where: { proxyId },
            create: {
              id: uuidv7(),
              name: message.agent.name,
              proxyId,
              status: "online",
              currentLoad: 0,
              maxConcurrentRuns: message.agent.max_concurrent ?? 1,
              capabilities: message.agent.capabilities ?? {}
            },
            update: {
              name: message.agent.name,
              status: "online",
              maxConcurrentRuns: message.agent.max_concurrent ?? 1,
              capabilities: message.agent.capabilities ?? {},
              lastHeartbeat: new Date()
            }
          });

          socket.send(JSON.stringify({ type: "register_ack", success: true }));

          void resumeRunningRuns({ proxyId, agentId: (agentRecord as any).id, logError }).catch(logError);
          return;
        }

        if (message.type === "heartbeat") {
          await deps.prisma.agent.update({
            where: { proxyId: message.agent_id },
            data: { lastHeartbeat: new Date(), status: "online" }
          });
          return;
        }

        if (message.type === "acp_opened") {
          if (proxyId && acpTunnelHandlers) {
            try {
              acpTunnelHandlers.handleAcpOpened(proxyId, message);
            } catch (err) {
              logError(err);
            }
          }
          return;
        }

        if (message.type === "acp_message") {
          if (proxyId && acpTunnelHandlers) {
            try {
              acpTunnelHandlers.handleAcpMessage(proxyId, message);
            } catch (err) {
              logError(err);
            }
          }
          return;
        }

        if (message.type === "acp_exit") {
          if (!proxyId) return;

          const instanceName =
            typeof message.instance_name === "string" && message.instance_name.trim()
              ? message.instance_name.trim()
              : deriveSandboxInstanceName(message.run_id);
          const code = typeof message.code === "number" && Number.isFinite(message.code) ? message.code : null;
          const signal = typeof message.signal === "string" && message.signal.trim() ? message.signal.trim() : null;
          const ok = code === null ? true : code === 0 && !signal;
          const status = ok ? "stopped" : "error";
          const now = new Date();
          const lastError = ok ? null : `acp_exit: code=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}`;

          await enqueueRunTask(message.run_id, async () => {
            await flushRunChunkBuffer(message.run_id);

            const createdEvent = await deps.prisma.event
              .create({
                data: {
                  id: uuidv7(),
                  runId: message.run_id,
                  source: "acp",
                  type: "sandbox.acp_exit",
                  payload: {
                    ...message,
                    instance_name: instanceName,
                    received_at: now.toISOString(),
                  } as any,
                } as any,
              })
              .catch(() => null);

            const runRes = await deps.prisma.run
              .updateMany({
                where: { id: message.run_id },
                data: {
                  sandboxInstanceName: instanceName,
                  sandboxStatus: status as any,
                  sandboxLastSeenAt: now,
                  sandboxLastError: lastError,
                } as any,
              } as any)
              .catch(() => ({ count: 0 }));

            await deps.prisma.sandboxInstance
              .upsert({
                where: { proxyId_instanceName: { proxyId, instanceName } } as any,
                create: {
                  id: uuidv7(),
                  proxyId,
                  instanceName,
                  ...(runRes.count > 0 ? { runId: message.run_id } : {}),
                  status: status as any,
                  lastSeenAt: now,
                  lastError,
                } as any,
                update: {
                  ...(runRes.count > 0 ? { runId: message.run_id } : {}),
                  status: status as any,
                  lastSeenAt: now,
                  lastError,
                } as any,
              } as any)
              .catch(() => {});

            if (createdEvent) {
              broadcastToClients({ type: "event_added", run_id: message.run_id, event: createdEvent });
            }
          });
          return;
        }

        if (message.type === "sandbox_inventory") {
          if (!proxyId) return;

          const instances = Array.isArray(message.instances) ? message.instances : [];
          const capturedAt = parseTimestamp(message.captured_at) ?? new Date();
          const providerDefault = typeof message.provider === "string" && message.provider.trim() ? message.provider.trim() : null;
          const runtimeDefault = typeof message.runtime === "string" && message.runtime.trim() ? message.runtime.trim() : null;

          for (const inst of instances) {
            if (!inst || typeof inst !== "object") continue;
            const instanceName = typeof inst.instance_name === "string" ? inst.instance_name.trim() : "";
            if (!instanceName) continue;

            const runId = typeof inst.run_id === "string" && inst.run_id.trim() ? inst.run_id.trim() : null;
            const status = normalizeSandboxStatus(inst.status);
            const createdAt = parseTimestamp(inst.created_at);
            const lastSeenAt = parseTimestamp(inst.last_seen_at) ?? capturedAt;
            const lastError = typeof inst.last_error === "string" && inst.last_error.trim() ? inst.last_error.trim() : null;
            const provider = typeof inst.provider === "string" && inst.provider.trim() ? inst.provider.trim() : providerDefault;
            const runtime = typeof inst.runtime === "string" && inst.runtime.trim() ? inst.runtime.trim() : runtimeDefault;

            const upsert = async (opts: { runExists: boolean }) => {
              await deps.prisma.sandboxInstance
                .upsert({
                  where: { proxyId_instanceName: { proxyId, instanceName } } as any,
                  create: {
                    id: uuidv7(),
                    proxyId,
                    instanceName,
                    ...(opts.runExists && runId ? { runId } : {}),
                    provider,
                    runtime,
                    ...(status ? { status: status as any } : {}),
                    ...(createdAt ? { createdAt } : {}),
                    lastSeenAt,
                    lastError,
                  } as any,
                  update: {
                    ...(opts.runExists && runId ? { runId } : {}),
                    provider,
                    runtime,
                    ...(status ? { status: status as any } : {}),
                    ...(createdAt ? { createdAt } : {}),
                    lastSeenAt,
                    lastError,
                  } as any,
                } as any)
                .catch(() => {});
            };

            if (runId) {
              await enqueueRunTask(runId, async () => {
                const runRes = await deps.prisma.run
                  .updateMany({
                    where: { id: runId },
                    data: {
                      sandboxInstanceName: instanceName,
                      ...(status ? { sandboxStatus: status as any } : {}),
                      sandboxLastSeenAt: lastSeenAt,
                      sandboxLastError: lastError,
                    } as any,
                  } as any)
                  .catch(() => ({ count: 0 }));

                await upsert({ runExists: runRes.count > 0 });
              });
              continue;
            }

            await upsert({ runExists: false });
          }

          return;
        }

        if (message.type === "agent_update") {
          const chunkSeg = extractChunkSegment(message.content);
          if (chunkSeg) {
            await enqueueRunTask(message.run_id, async () => {
              await bufferChunkSegment(message.run_id, chunkSeg, logError);
            });
            return;
          }

          await enqueueRunTask(message.run_id, async () => {
            await flushRunChunkBuffer(message.run_id);

            const createdEvent = await deps.prisma.event.create({
              data: {
                id: uuidv7(),
                runId: message.run_id,
                source: "acp",
                type: "acp.update.received",
                payload: message.content as any
              }
            });

            const contentType = isRecord(message.content) ? message.content.type : undefined;
            if (contentType === "sandbox_instance_status") {
              const raw = message.content as any;
              const instanceName =
                typeof raw.instance_name === "string" && raw.instance_name.trim()
                  ? raw.instance_name.trim()
                  : deriveSandboxInstanceName(message.run_id);
              const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null;
              const runtime = typeof raw.runtime === "string" && raw.runtime.trim() ? raw.runtime.trim() : null;
              const status = normalizeSandboxStatus(raw.status);
              const lastSeenAt = parseTimestamp(raw.last_seen_at) ?? new Date();
              const lastError = typeof raw.last_error === "string" && raw.last_error.trim() ? raw.last_error.trim() : null;

              const runData: any = {
                sandboxInstanceName: instanceName,
                ...(status ? { sandboxStatus: status } : {}),
                sandboxLastSeenAt: lastSeenAt,
                sandboxLastError: lastError,
              };
              const runRes = await deps.prisma.run
                .updateMany({ where: { id: message.run_id }, data: runData } as any)
                .catch(() => ({ count: 0 }));

              if (proxyId) {
                await deps.prisma.sandboxInstance
                  .upsert({
                    where: { proxyId_instanceName: { proxyId, instanceName } } as any,
                    create: {
                      id: uuidv7(),
                      proxyId,
                      instanceName,
                      ...(runRes.count > 0 ? { runId: message.run_id } : {}),
                      provider,
                      runtime,
                      ...(status ? { status: status as any } : {}),
                      lastSeenAt,
                      lastError,
                    } as any,
                    update: {
                      ...(runRes.count > 0 ? { runId: message.run_id } : {}),
                      provider,
                      runtime,
                      ...(status ? { status: status as any } : {}),
                      lastSeenAt,
                      lastError,
                    } as any,
                  } as any)
                  .catch(() => {});
              }
            }

            if (contentType === "session_created") {
              const sessionId = isRecord(message.content) ? message.content.session_id : undefined;
              if (typeof sessionId === "string" && sessionId) {
                await deps.prisma.run
                  .update({
                    where: { id: message.run_id },
                    data: { acpSessionId: sessionId }
                  })
                  .catch(() => {});
              }
            }

            if (contentType === "session_state") {
              const raw = message.content as any;
              const sessionId = typeof raw.session_id === "string" ? raw.session_id : "";
              const activity = typeof raw.activity === "string" ? raw.activity : "";
              const inFlightRaw = raw.in_flight;
              const inFlight =
                typeof inFlightRaw === "number" && Number.isFinite(inFlightRaw) ? Math.max(0, inFlightRaw) : 0;
              const updatedAt = typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString();
              const currentModeId = typeof raw.current_mode_id === "string" ? raw.current_mode_id : null;
              const currentModelId = typeof raw.current_model_id === "string" ? raw.current_model_id : null;
              const lastStopReason = typeof raw.last_stop_reason === "string" ? raw.last_stop_reason : null;
              const note = typeof raw.note === "string" ? raw.note : null;

              if (sessionId) {
                const run = await deps.prisma.run
                  .findUnique({ where: { id: message.run_id }, select: { metadata: true } })
                  .catch(() => null);
                const prev = run && isRecord(run.metadata) ? (run.metadata as Record<string, unknown>) : {};
                const next = {
                  ...prev,
                  acpSessionState: {
                    sessionId,
                    activity,
                    inFlight,
                    updatedAt,
                    currentModeId,
                    currentModelId,
                    lastStopReason,
                    note,
                  },
                };
                await deps.prisma.run
                  .update({ where: { id: message.run_id }, data: { metadata: next as any } })
                  .catch(() => {});
              }
            }

            if (contentType === "prompt_result") {
              const run = await deps.prisma.run.findUnique({
                where: { id: message.run_id },
                select: { id: true, status: true, issueId: true, agentId: true, taskId: true, stepId: true }
              });

              if (run && run.status === "running") {
                await deps.prisma.run.update({
                  where: { id: run.id },
                  data: { status: "completed", completedAt: new Date() }
                });

                const advanced = await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(
                  () => ({ handled: false }),
                );

                if (advanced.handled && run.taskId) {
                  broadcastToClients({
                    type: "task_updated",
                    issue_id: run.issueId,
                    task_id: run.taskId,
                    step_id: run.stepId ?? undefined,
                    run_id: run.id,
                  });
                }

                if (!advanced.handled) {
                  await deps.prisma.issue
                    .updateMany({
                      where: { id: run.issueId, status: "running" },
                      data: { status: "reviewing" }
                    })
                    .catch(() => {});
                }

                if (run.agentId) {
                  await deps.prisma.agent
                    .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
                    .catch(() => {});
                }

                triggerPmAutoAdvance(
                  { prisma: deps.prisma },
                  { runId: run.id, issueId: run.issueId, trigger: "run_completed" },
                );

                if (run.taskId) {
                  triggerTaskAutoAdvance(
                    { prisma: deps.prisma, sendToAgent, broadcastToClients },
                    { issueId: run.issueId, taskId: run.taskId, trigger: "step_completed" },
                  );
                }
              }
            }

            if (contentType === "init_result") {
              const ok = isRecord(message.content) ? (message.content as any).ok : undefined;
              if (ok === false) {
                const exitCode = isRecord(message.content) ? (message.content as any).exitCode : undefined;
                const errText = isRecord(message.content) ? (message.content as any).error : undefined;
                const details =
                  typeof errText === "string" && errText.trim()
                    ? errText.trim()
                    : typeof exitCode === "number"
                      ? `exitCode=${exitCode}`
                      : "unknown";

                const run = await deps.prisma.run.findUnique({
                  where: { id: message.run_id },
                  select: { id: true, status: true, issueId: true, agentId: true, taskId: true, stepId: true }
                });

                if (run && run.status === "running") {
                  await deps.prisma.run
                    .update({
                      where: { id: run.id },
                      data: {
                        status: "failed",
                        completedAt: new Date(),
                        failureReason: "init_failed",
                        errorMessage: `initScript 失败: ${details}`
                      }
                    })
                    .catch(() => {});

                  const advanced = await advanceTaskFromRunTerminal(
                    { prisma: deps.prisma },
                    run.id,
                    "failed",
                    { errorMessage: `initScript 失败: ${details}` },
                  ).catch(() => ({ handled: false }));

                  if (advanced.handled && (run as any).taskId) {
                    broadcastToClients({
                      type: "task_updated",
                      issue_id: (run as any).issueId,
                      task_id: (run as any).taskId,
                      step_id: (run as any).stepId ?? undefined,
                      run_id: (run as any).id,
                    });
                  }

                  if (!advanced.handled) {
                    await deps.prisma.issue
                      .updateMany({
                        where: { id: run.issueId, status: "running" },
                        data: { status: "failed" }
                      })
                      .catch(() => {});
                  }

                  if (run.agentId) {
                    await deps.prisma.agent
                      .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
                      .catch(() => {});
                  }
                }
              }
            }

            broadcastToClients({ type: "event_added", run_id: message.run_id, event: createdEvent });
          });
          return;
        }

        if (message.type === "branch_created") {
          await enqueueRunTask(message.run_id, async () => {
            await flushRunChunkBuffer(message.run_id);
            const createdArtifact = await deps.prisma.artifact.create({
              data: {
                id: uuidv7(),
                runId: message.run_id,
                type: "branch",
                content: { branch: message.branch } as any
              }
            });
            await deps.prisma.run
              .update({ where: { id: message.run_id }, data: { branchName: message.branch } })
              .catch(() => {});
            broadcastToClients({ type: "artifact_added", run_id: message.run_id, artifact: createdArtifact });
          });
          return;
        }
      } catch (error) {
        logError(error);
      }
    });

    socket.on("close", async () => {
      if (!proxyId) return;
      agentConnections.delete(proxyId);
      await deps.prisma.agent
        .update({ where: { proxyId }, data: { status: "offline" } })
        .catch(() => {});
      acpTunnelHandlers?.handleProxyDisconnected?.(proxyId);
    });
  }

  function handleClientConnection(socket: WebSocket) {
    clientConnections.add(socket);
    socket.on("close", () => {
      clientConnections.delete(socket);
    });
  }

  function init(server: FastifyInstance) {
    server.get("/ws/agent", { websocket: true }, (socket) => {
      handleAgentConnection(socket, (err) => server.log.error(err));
    });

    server.get("/ws/client", { websocket: true }, (socket) => {
      handleClientConnection(socket);
    });
  }

  return {
    init,
    sendToAgent,
    broadcastToClients,
    setAcpTunnel: (tunnel: AcpTunnel) => {
      acpTunnel = tunnel;
    },
    setAcpTunnelHandlers: (handlers: {
      handleAcpOpened: (proxyId: string, payload: unknown) => void;
      handleAcpMessage: (proxyId: string, payload: unknown) => void;
      handleProxyDisconnected?: (proxyId: string) => void;
    }) => {
      acpTunnelHandlers = handlers;
    },
    __testing: {
      agentConnections,
      clientConnections,
      handleAgentConnection,
      handleClientConnection
    }
  };
}
