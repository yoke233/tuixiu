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
      agent: { upsert: vi.fn().mockResolvedValue({}) }
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

  it("agent_update persists event and prompt_result completes run/issue and broadcasts", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      run: { update: vi.fn().mockResolvedValue({ agentId: "a1", issueId: "i1" }) },
      agent: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) }
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
    expect(prisma.run.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(clientSocket.sent.some((s) => JSON.parse(s).type === "event_added")).toBe(true);
  });

  it("branch_created persists artifact and broadcasts", async () => {
    const prisma = {
      artifact: { create: vi.fn().mockResolvedValue({}) }
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
    expect(clientSocket.sent.some((s) => JSON.parse(s).type === "artifact_added")).toBe(true);
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
      }
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
