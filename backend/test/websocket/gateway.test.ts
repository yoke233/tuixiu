import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createWebSocketGateway } from "../../src/websocket/gateway.js";
import { flushMicrotasks } from "../test-utils.js";

class FakeSocket extends EventEmitter {
  public sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

describe("WebSocketGateway", () => {
  it("register_agent upserts agent and acks; sendToAgent routes to socket", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    gateway.__testing.handleAgentConnection(socket as any, vi.fn());

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "register_agent",
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 2 }
        })
      )
    );
    await flushMicrotasks();

    expect(prisma.agent.upsert).toHaveBeenCalled();
    expect(socket.sent.some((s) => JSON.parse(s).type === "register_ack")).toBe(true);

    await gateway.sendToAgent("proxy-1", { hello: "world" });
    expect(socket.sent.some((s) => JSON.parse(s).hello === "world")).toBe(true);
  });

  it("register_agent sends prompt_run to resume running runs", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "r1",
            status: "running",
            acpSessionId: "s1",
            workspacePath: "C:/repo/.worktrees/run-1",
            branchName: "run/1",
            issue: { title: "Issue 1", description: "desc" },
            artifacts: [],
          },
          {
            id: "r2",
            status: "running",
            acpSessionId: null,
            workspacePath: "C:/repo/.worktrees/run-2",
            branchName: "run/2",
            issue: { title: "Issue 2" },
            artifacts: [],
          },
        ]),
      },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    gateway.__testing.handleAgentConnection(socket as any, vi.fn());

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "register_agent",
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 2 },
        }),
      ),
    );
    await flushMicrotasks();

    const sent = socket.sent.map((s) => JSON.parse(s));
    const resumes = sent.filter((m) => m.type === "prompt_run");
    expect(resumes.map((m) => m.run_id).sort()).toEqual(["r1", "r2"]);
    expect(resumes.every((m) => m.resume === true)).toBe(true);
    expect(resumes.find((m) => m.run_id === "r1")?.session_id).toBe("s1");
    expect(resumes.find((m) => m.run_id === "r2")?.session_id).toBeUndefined();
    expect(resumes.find((m) => m.run_id === "r1")?.cwd).toBe("C:/repo/.worktrees/run-1");
  });

  it("logs error when receiving invalid JSON", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({}) }
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    const logError = vi.fn();
    gateway.__testing.handleAgentConnection(socket as any, logError);

    socket.emit("message", Buffer.from("{not_json"));
    await flushMicrotasks();

    expect(logError).toHaveBeenCalled();
  });

  it("heartbeat updates agent lastHeartbeat", async () => {
    const prisma = {
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    gateway.__testing.handleAgentConnection(socket as any, vi.fn());

    socket.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat", agent_id: "proxy-1" })));
    await flushMicrotasks();

    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { proxyId: "proxy-1" },
      data: { lastHeartbeat: expect.any(Date), status: "online" }
    });
  });

  it("agent_update persists event and broadcasts", async () => {
    const prisma = {
      event: {
        create: vi.fn().mockResolvedValue({
          id: "e1",
          runId: "r1",
          source: "acp",
          type: "acp.update.received",
          payload: { type: "prompt_result" },
          timestamp: new Date()
        })
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "running",
          issueId: "i1",
          agentId: "a1"
        }),
        update: vi.fn().mockResolvedValue({})
      },
      issue: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agent: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "agent_update", run_id: "r1", content: { type: "prompt_result" } }))
    );
    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalled();
    expect(prisma.run.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "r1" },
      select: { id: true, status: true, issueId: true, agentId: true, taskId: true, stepId: true }
    });
    expect(prisma.run.update).toHaveBeenCalled();
    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", status: "running" },
      data: { status: "reviewing" }
    });
    expect(prisma.agent.update).toHaveBeenCalled();
    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "event_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
    expect(msg.event).toBeTruthy();
  });

  it("coalesces agent_message_chunk session_update before persisting", async () => {
    let n = 0;
    const prisma = {
      event: {
        create: vi.fn().mockImplementation(async ({ data }: any) => {
          n += 1;
          return {
            id: `e${n}`,
            runId: data.runId,
            source: data.source,
            type: data.type,
            payload: data.payload,
            timestamp: new Date()
          };
        })
      }
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "agent_update",
          run_id: "r1",
          content: {
            type: "session_update",
            session: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello " }
            }
          }
        })
      )
    );

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "agent_update",
          run_id: "r1",
          content: {
            type: "session_update",
            session: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "world" }
            }
          }
        })
      )
    );

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "agent_update",
          run_id: "r1",
          content: { type: "text", text: "[done]" }
        })
      )
    );

    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalledTimes(2);
    const payload = prisma.event.create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({
      type: "session_update",
      session: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" }
      }
    });

    const msg = clientSocket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "event_added");
    expect(msg.length).toBe(2);
  });

  it("session_created updates run.acpSessionId", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      run: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "agent_update", run_id: "r1", content: { type: "session_created", session_id: "s1" } }))
    );
    await flushMicrotasks();

    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { acpSessionId: "s1" }
    });
    expect(clientSocket.sent.some((s) => JSON.parse(s).type === "event_added")).toBe(true);
  });

  it("init_result(ok=false) marks run/issue failed and decrements agent load", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "running",
          issueId: "i1",
          agentId: "a1"
        }),
        update: vi.fn().mockResolvedValue({})
      },
      issue: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "agent_update",
          run_id: "r1",
          content: { type: "init_result", ok: false, exitCode: 1 }
        })
      )
    );
    await flushMicrotasks();

    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ status: "failed", failureReason: "init_failed" })
      })
    );
    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", status: "running" },
      data: { status: "failed" }
    });
    expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { currentLoad: { decrement: 1 } } });
  });

  it("branch_created persists artifact and broadcasts", async () => {
    const prisma = {
      artifact: { create: vi.fn().mockResolvedValue({ id: "art1", type: "branch" }) },
      run: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "branch_created", run_id: "r1", branch: "acp/test" }))
    );
    await flushMicrotasks();

    expect(prisma.artifact.create).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { branchName: "acp/test" } });
    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "artifact_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
    expect(msg.artifact).toBeTruthy();
  });

  it("client close removes from broadcast list", async () => {
    const prisma = {} as any;
    const gateway = createWebSocketGateway({ prisma });
    const clientSocket = new FakeSocket();
    gateway.__testing.handleClientConnection(clientSocket as any);

    clientSocket.emit("close");
    gateway.broadcastToClients({ type: "ping" });

    expect(clientSocket.sent).toEqual([]);
  });

  it("init registers websocket routes", () => {
    const prisma = {} as any;
    const gateway = createWebSocketGateway({ prisma });

    const calls: any[] = [];
    const server = {
      get: (path: string, opts: any, handler: any) => {
        calls.push({ path, opts, handler });
      },
      log: { error: vi.fn() }
    };

    gateway.init(server as any);

    expect(calls.map((c) => c.path)).toEqual(["/ws/agent", "/ws/client"]);
    expect(calls.every((c) => c.opts && c.opts.websocket === true)).toBe(true);
    expect(calls.every((c) => typeof c.handler === "function")).toBe(true);

    const agentHandler = calls.find((c) => c.path === "/ws/agent")?.handler;
    const clientHandler = calls.find((c) => c.path === "/ws/client")?.handler;
    expect(typeof agentHandler).toBe("function");
    expect(typeof clientHandler).toBe("function");

    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    agentHandler(agentSocket as any);
    clientHandler(clientSocket as any);

    expect(agentSocket.listenerCount("message")).toBeGreaterThan(0);
    expect(gateway.__testing.clientConnections.has(clientSocket as any)).toBe(true);

    clientSocket.emit("close");
    expect(gateway.__testing.clientConnections.has(clientSocket as any)).toBe(false);
  });

  it("close marks agent offline and removes connection", async () => {
    const prisma = {
      agent: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({})
      },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    gateway.__testing.handleAgentConnection(socket as any, vi.fn());

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "register_agent",
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 1 }
        })
      )
    );
    await flushMicrotasks();

    socket.emit("close");
    await flushMicrotasks();

    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { proxyId: "proxy-1" },
      data: { status: "offline" }
    });
    await expect(gateway.sendToAgent("proxy-1", { x: 1 })).rejects.toThrow(/not connected/);
  });
});
