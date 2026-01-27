import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { PrismaDeps } from "../deps.js";
import { buildContextFromRun } from "../services/runContext.js";
import { triggerPmAutoAdvance } from "../services/pm/pmAutoAdvance.js";
import { advanceTaskFromRunTerminal } from "../services/taskProgress.js";
import { uuidv7 } from "../utils/uuid.js";

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

type BranchCreatedMessage = {
  type: "branch_created";
  run_id: string;
  branch: string;
};

type AnyAgentMessage =
  | AgentRegisterMessage
  | AgentHeartbeatMessage
  | AgentUpdateMessage
  | BranchCreatedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function createWebSocketGateway(deps: { prisma: PrismaDeps }) {
  const agentConnections = new Map<string, WebSocket>();
  const clientConnections = new Set<WebSocket>();

  async function resumeRunningRuns(opts: { proxyId: string; agentId: string; socket: WebSocket }) {
    const runs = await deps.prisma.run.findMany({
      where: { agentId: opts.agentId, status: "running" },
      include: { issue: true, artifacts: true },
      orderBy: { startedAt: "asc" }
    });

    for (const run of runs as any[]) {
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

      opts.socket.send(
        JSON.stringify({
          type: "prompt_run",
          run_id: run.id,
          session_id: run.acpSessionId ?? undefined,
          prompt:
            "（系统）检测到 acp-proxy 断线重连/重启。请在当前工作目录(该 Run 的 workspace)检查进度（git status/最近改动/已有 commit）后继续完成任务；若你判断任务已完成，请输出总结并结束。",
          context,
          cwd: run.workspacePath ?? undefined,
          resume: true
        })
      );
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

          void resumeRunningRuns({ proxyId, agentId: (agentRecord as any).id, socket }).catch(logError);
          return;
        }

        if (message.type === "heartbeat") {
          await deps.prisma.agent.update({
            where: { proxyId: message.agent_id },
            data: { lastHeartbeat: new Date(), status: "online" }
          });
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
    __testing: {
      agentConnections,
      clientConnections,
      handleAgentConnection,
      handleClientConnection
    }
  };
}
