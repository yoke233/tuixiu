import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

import type { PrismaDeps } from "../deps.js";
import { buildContextFromRun } from "../services/runContext.js";
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
              select: { id: true, status: true, issueId: true, agentId: true }
            });

            if (run && run.status === "running") {
              await deps.prisma.run.update({
                where: { id: run.id },
                data: { status: "completed", completedAt: new Date() }
              });

              await deps.prisma.issue
                .updateMany({
                  where: { id: run.issueId, status: "running" },
                  data: { status: "reviewing" }
                })
                .catch(() => {});

              await deps.prisma.agent
                .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
                .catch(() => {});
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
                select: { id: true, status: true, issueId: true, agentId: true }
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

                await deps.prisma.issue
                  .updateMany({
                    where: { id: run.issueId, status: "running" },
                    data: { status: "failed" }
                  })
                  .catch(() => {});

                await deps.prisma.agent
                  .update({ where: { id: run.agentId }, data: { currentLoad: { decrement: 1 } } })
                  .catch(() => {});
              }
            }
          }

          broadcastToClients({ type: "event_added", run_id: message.run_id, event: createdEvent });
          return;
        }

        if (message.type === "branch_created") {
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
