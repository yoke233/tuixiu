import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { createWebSocketGateway } from "../../src/websocket/gateway.js";
import { createAcpTunnel } from "../../src/modules/acp/acpTunnel.js";
import { flushMicrotasks } from "../test-utils.js";

class FakeSocket extends EventEmitter {
  public sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.emit("close", code, reason);
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
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 2 },
        }),
      ),
    );
    await flushMicrotasks();

    expect(prisma.agent.upsert).toHaveBeenCalled();
    expect(socket.sent.some((s) => JSON.parse(s).type === "register_ack")).toBe(true);

    await gateway.sendToAgent("proxy-1", { hello: "world" });
    expect(socket.sent.some((s) => JSON.parse(s).hello === "world")).toBe(true);
  });

  it("register_agent resumes running runs via acpTunnel", async () => {
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
    const promptRun = vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" });
    gateway.setAcpTunnel({ promptRun } as any);
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
    await flushMicrotasks();

    expect(promptRun).toHaveBeenCalledTimes(2);
    expect(promptRun.mock.calls.map((c) => c[0].runId).sort()).toEqual(["r1", "r2"]);

    const callR1 = promptRun.mock.calls.find((c) => c[0].runId === "r1")?.[0];
    expect(callR1?.proxyId).toBe("proxy-1");
    expect(callR1?.sessionId).toBe("s1");
    expect(callR1?.cwd).toBe("C:/repo/.worktrees/run-1");

    const callR2 = promptRun.mock.calls.find((c) => c[0].runId === "r2")?.[0];
    expect(callR2?.sessionId).toBeNull();
  });

  it("register_agent skips stopped/missing sandbox runs", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "r1",
            status: "running",
            sandboxStatus: "running",
            acpSessionId: "s1",
            workspacePath: "C:/repo/.worktrees/run-1",
            branchName: "run/1",
            issue: { title: "Issue 1", description: "desc" },
            artifacts: [],
          },
          {
            id: "r2",
            status: "running",
            sandboxStatus: "stopped",
            acpSessionId: "s2",
            workspacePath: "C:/repo/.worktrees/run-2",
            branchName: "run/2",
            issue: { title: "Issue 2" },
            artifacts: [],
          },
          {
            id: "r3",
            status: "running",
            sandboxStatus: "missing",
            acpSessionId: "s3",
            workspacePath: "C:/repo/.worktrees/run-3",
            branchName: "run/3",
            issue: { title: "Issue 3" },
            artifacts: [],
          },
        ]),
      },
      event: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const promptRun = vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" });
    gateway.setAcpTunnel({ promptRun } as any);
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
    await flushMicrotasks();

    expect(promptRun).toHaveBeenCalledTimes(1);
    expect(promptRun.mock.calls[0]?.[0]?.runId).toBe("r1");
  });

  it("logs error when receiving invalid JSON", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({}) },
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
      agent: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const socket = new FakeSocket();
    gateway.__testing.handleAgentConnection(socket as any, vi.fn());

    socket.emit("message", Buffer.from(JSON.stringify({ type: "heartbeat", agent_id: "proxy-1" })));
    await flushMicrotasks();

    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { proxyId: "proxy-1" },
      data: { lastHeartbeat: expect.any(Date), status: "online" },
    });
  });

  it("proxy_update persists event and broadcasts", async () => {
    const prisma = {
      event: {
        create: vi.fn().mockResolvedValue({
          id: "e1",
          runId: "r1",
          source: "acp",
          type: "acp.update.received",
          payload: { type: "prompt_result" },
          timestamp: new Date(),
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "running",
          issueId: "i1",
          agentId: "a1",
        }),
        update: vi.fn().mockResolvedValue({}),
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
      Buffer.from(
        JSON.stringify({ type: "proxy_update", run_id: "r1", content: { type: "prompt_result" } }),
      ),
    );
    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalled();
    expect(prisma.run.findUnique).toHaveBeenNthCalledWith(1, {
      where: { id: "r1" },
      select: { id: true, status: true, issueId: true, agentId: true, taskId: true, stepId: true },
    });
    expect(prisma.run.update).toHaveBeenCalled();
    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", status: "running" },
      data: { status: "reviewing" },
    });
    expect(prisma.agent.update).toHaveBeenCalled();
    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "event_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
    expect(msg.event).toBeTruthy();
  });

  it("proxy_update sandbox_instance_status updates run and upserts sandboxInstance", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      event: {
        create: vi.fn().mockResolvedValue({
          id: "e1",
          runId: "r1",
          source: "acp",
          type: "acp.update.received",
          payload: { type: "sandbox_instance_status" },
          timestamp: new Date(),
        }),
      },
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_update",
          run_id: "r1",
          content: {
            type: "sandbox_instance_status",
            instance_name: "tuixiu-run-r1",
            provider: "container_oci",
            runtime: "docker",
            status: "running",
            last_seen_at: "2026-01-28T12:00:00.000Z",
            last_error: null,
          },
        }),
      ),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({
          sandboxInstanceName: "tuixiu-run-r1",
          sandboxStatus: "running",
          sandboxLastSeenAt: expect.any(Date),
          sandboxLastError: null,
        }),
      }),
    );

    expect(prisma.sandboxInstance.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.sandboxInstance.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({
      proxyId_instanceName: { proxyId: "proxy-1", instanceName: "tuixiu-run-r1" },
    });
    expect(upsertArg.create).toMatchObject({
      proxyId: "proxy-1",
      instanceName: "tuixiu-run-r1",
      runId: "r1",
      provider: "container_oci",
      runtime: "docker",
      status: "running",
    });

    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "event_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
  });

  it("acp_exit updates run and upserts sandboxInstance", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      event: {
        create: vi.fn().mockResolvedValue({
          id: "e1",
          runId: "r1",
          source: "acp",
          type: "sandbox.acp_exit",
          payload: { type: "acp_exit" },
          timestamp: new Date(),
        }),
      },
      run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "acp_exit",
          run_id: "r1",
          instance_name: "tuixiu-run-r1",
          code: 1,
          signal: null,
        }),
      ),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ runId: "r1", type: "sandbox.acp_exit" }),
      }),
    );

    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({
          sandboxInstanceName: "tuixiu-run-r1",
          sandboxStatus: "error",
        }),
      }),
    );

    expect(prisma.sandboxInstance.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.sandboxInstance.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({
      proxyId_instanceName: { proxyId: "proxy-1", instanceName: "tuixiu-run-r1" },
    });
    expect(upsertArg.create).toMatchObject({
      proxyId: "proxy-1",
      instanceName: "tuixiu-run-r1",
      runId: "r1",
      status: "error",
    });

    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "event_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
  });

  it("sandbox_inventory upserts instances and updates run when run_id present", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "sandbox_inventory",
          inventory_id: "inv-1",
          provider: "container_oci",
          runtime: "docker",
          captured_at: "2026-01-28T12:00:00.000Z",
          instances: [
            {
              instance_name: "tuixiu-run-r1",
              run_id: "r1",
              status: "running",
              created_at: "2026-01-28T10:00:00.000Z",
              last_seen_at: "2026-01-28T12:00:00.000Z",
            },
          ],
        }),
      ),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({
          sandboxInstanceName: "tuixiu-run-r1",
          sandboxStatus: "running",
          sandboxLastSeenAt: expect.any(Date),
        }),
      }),
    );

    expect(prisma.sandboxInstance.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.sandboxInstance.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({
      proxyId_instanceName: { proxyId: "proxy-1", instanceName: "tuixiu-run-r1" },
    });
    expect(upsertArg.create).toMatchObject({
      proxyId: "proxy-1",
      instanceName: "tuixiu-run-r1",
      runId: "r1",
      provider: "container_oci",
      runtime: "docker",
      status: "running",
    });
  });

  it("sandbox_inventory marks missing instances", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "sandbox_inventory",
          inventory_id: "inv-2",
          captured_at: "2026-01-28T12:00:00.000Z",
          missing_instances: [
            {
              instance_name: "tuixiu-run-r2",
              run_id: "r2",
            },
          ],
        }),
      ),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(prisma.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r2" },
        data: expect.objectContaining({
          sandboxInstanceName: "tuixiu-run-r2",
          sandboxStatus: "missing",
          sandboxLastSeenAt: expect.any(Date),
          sandboxLastError: "inventory_missing",
        }),
      }),
    );

    expect(prisma.sandboxInstance.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prisma.sandboxInstance.upsert.mock.calls[0][0];
    expect(upsertArg.create).toMatchObject({
      proxyId: "proxy-1",
      instanceName: "tuixiu-run-r2",
      runId: "r2",
      status: "missing",
      lastError: "inventory_missing",
    });
  });

  it("sandbox_inventory accepts deleted_instances and writes deletedAt", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "sandbox_inventory",
          inventory_id: "inv-3",
          captured_at: "2026-01-31T12:00:00.000Z",
          deleted_instances: [{ instance_name: "tuixiu-run-r3", run_id: "r3" }],
        }),
      ),
    );
    await flushMicrotasks();
    await flushMicrotasks();

    expect(prisma.sandboxInstance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          proxyId: "proxy-1",
          instanceName: "tuixiu-run-r3",
          runId: "r3",
          status: "missing",
          lastError: "deleted",
          deletedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("workspace_inventory broadcasts to clients", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "workspace_inventory",
          inventory_id: "ws-1",
          captured_at: "2026-01-31T12:00:00.000Z",
          workspaces: [{ run_id: "r1", host_path: "C:/repo/run-r1", exists: true }],
        }),
      ),
    );
    await flushMicrotasks();

    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "workspace_inventory");
    expect(msg).toBeTruthy();
    expect(msg.proxy_id).toBe("proxy-1");
    expect(msg.inventory_id).toBe("ws-1");
  });

  it("acp_update broadcasts acp.update to clients", async () => {
    const prisma = {
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "acp_update",
          run_id: "r1",
          prompt_id: "p1",
          session_id: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        }),
      ),
    );
    await flushMicrotasks();

    const msg = clientSocket.sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === "acp.update");
    expect(msg).toBeTruthy();
    expect(msg).toMatchObject({
      type: "acp.update",
      run_id: "r1",
      prompt_id: "p1",
      session_id: "s1",
    });
    expect(msg.update?.sessionUpdate).toBe("agent_message_chunk");
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
            timestamp: new Date(),
          };
        }),
      },
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
          type: "proxy_update",
          run_id: "r1",
          content: {
            type: "session_update",
            session: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello " },
            },
          },
        }),
      ),
    );

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_update",
          run_id: "r1",
          content: {
            type: "session_update",
            session: "s1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "world" },
            },
          },
        }),
      ),
    );

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_update",
          run_id: "r1",
          content: { type: "text", text: "[done]" },
        }),
      ),
    );

    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalledTimes(2);
    const payload = prisma.event.create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({
      type: "session_update",
      session: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      },
    });

    const msg = clientSocket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "event_added");
    expect(msg.length).toBe(2);
  });

  it("session_created updates run.acpSessionId", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          agent: { proxyId: "proxy-1" },
          metadata: null,
          acpSessionId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    gateway.setAcpTunnelHandlers(
      createAcpTunnel({
        prisma,
        sendToAgent: vi.fn(),
        broadcastToClients: gateway.broadcastToClients,
      } as any).gatewayHandlers,
    );
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "register_agent",
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 2 },
        }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "acp_update",
          run_id: "r1",
          prompt_id: null,
          session_id: "s1",
          update: { sessionUpdate: "session_created", content: { type: "session_created" } },
        }),
      ),
    );
    await flushMicrotasks();

    expect(prisma.run.updateMany).toHaveBeenCalledWith({
      where: { id: "r1", acpSessionId: null },
      data: { acpSessionId: "s1" },
    });
    expect(clientSocket.sent.some((s) => JSON.parse(s).type === "event_added")).toBe(true);
  });

  it("session_state updates run.metadata.acpSessionState", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      run: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          agent: { proxyId: "proxy-1" },
          metadata: { roleKey: "dev" },
          acpSessionId: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.setAcpTunnelHandlers(
      createAcpTunnel({
        prisma,
        sendToAgent: vi.fn(),
        broadcastToClients: gateway.broadcastToClients,
      } as any).gatewayHandlers,
    );

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "register_agent",
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 2 },
        }),
      ),
    );
    await flushMicrotasks();

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "acp_update",
          run_id: "r1",
          prompt_id: null,
          session_id: "s1",
          update: {
            sessionUpdate: "session_state",
            content: {
              type: "session_state",
              activity: "busy",
              in_flight: 2,
              updated_at: "2026-01-25T00:00:00.000Z",
              current_mode_id: "m1",
              current_model_id: "model1",
              last_stop_reason: "end_turn",
              note: "prompt_start",
            },
          },
        }),
      ),
    );

    await flushMicrotasks();

    expect(prisma.run.findUnique).toHaveBeenCalledWith({
      where: { id: "r1" },
      select: { metadata: true, acpSessionId: true },
    });
    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: {
        metadata: {
          roleKey: "dev",
          acpSessionState: {
            sessionId: "s1",
            activity: "busy",
            inFlight: 2,
            updatedAt: "2026-01-25T00:00:00.000Z",
            currentModeId: "m1",
            currentModelId: "model1",
            lastStopReason: "end_turn",
            note: "prompt_start",
          },
        },
      },
    });
  });

  it("init_result(ok=false) marks run/issue failed and decrements agent load", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "running",
          issueId: "i1",
          agentId: "a1",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agent: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

    agentSocket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "proxy_update",
          run_id: "r1",
          content: { type: "init_result", ok: false, exitCode: 1 },
        }),
      ),
    );
    await flushMicrotasks();

    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ status: "failed", failureReason: "init_failed" }),
      }),
    );
    expect(prisma.issue.updateMany).toHaveBeenCalledWith({
      where: { id: "i1", status: "running" },
      data: { status: "failed" },
    });
    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { currentLoad: { decrement: 1 } },
    });
  });

  it("branch_created persists event and broadcasts", async () => {
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({ id: "e1", type: "scm.branch.created" }) },
      run: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const gateway = createWebSocketGateway({ prisma });
    const agentSocket = new FakeSocket();
    const clientSocket = new FakeSocket();
    gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());
    gateway.__testing.handleClientConnection(clientSocket as any);

    agentSocket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "branch_created", run_id: "r1", branch: "acp/test" })),
    );
    await flushMicrotasks();

    expect(prisma.event.create).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { branchName: "acp/test" },
    });
    const msg = clientSocket.sent.map((s) => JSON.parse(s)).find((m) => m.type === "event_added");
    expect(msg).toBeTruthy();
    expect(msg.run_id).toBe("r1");
    expect(msg.event).toBeTruthy();
    expect(msg.event.type).toBe("scm.branch.created");
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

  it("init registers websocket routes", async () => {
    const prisma = {} as any;
    const gateway = createWebSocketGateway({ prisma });

    const calls: any[] = [];
    const server = {
      get: (path: string, opts: any, handler: any) => {
        calls.push({ path, opts, handler });
      },
      jwt: {
        verify: vi.fn().mockImplementation(async (token: string) => {
          if (token !== "t") throw new Error("bad token");
          return { type: "acp_proxy" };
        }),
      },
      log: { error: vi.fn() },
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
    await agentHandler(agentSocket as any, { url: "/ws/agent?token=t" } as any);
    await clientHandler(clientSocket as any, { url: "/ws/client", headers: { cookie: "tuixiu_access=t" } } as any);

    expect(agentSocket.listenerCount("message")).toBeGreaterThan(0);
    expect(gateway.__testing.clientConnections.has(clientSocket as any)).toBe(true);

    clientSocket.emit("close");
    expect(gateway.__testing.clientConnections.has(clientSocket as any)).toBe(false);
  });

  it("close marks agent offline and removes connection", async () => {
    const prisma = {
      agent: {
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
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
          agent: { id: "proxy-1", name: "codex-1", max_concurrent: 1 },
        }),
      ),
    );
    await flushMicrotasks();

    socket.emit("close");
    await flushMicrotasks();

    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { proxyId: "proxy-1" },
      data: { status: "offline" },
    });
    await expect(gateway.sendToAgent("proxy-1", { x: 1 })).rejects.toThrow(/not connected/);
  });
});
