import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

vi.mock("@agentclientprotocol/sdk", async () => {
  class RequestError extends Error {
    code: number;
    data: any;
    constructor(message: string, code: number, data?: any) {
      super(message);
      this.code = code;
      this.data = data;
    }

    static invalidParams(data: any) {
      return new RequestError("invalid_params", -32602, data);
    }

    static resourceNotFound(id: string) {
      return new RequestError("resource_not_found", -32004, { id });
    }
  }

  const testing = {
    initializeResponse: {
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: true, audio: true },
      },
      authMethods: [{ id: "m1" }],
    } as any,
    newSessionCalls: [] as any[],
    loadSessionCalls: [] as any[],
    promptCalls: [] as any[],
    authenticateCalls: [] as any[],
    cancelCalls: [] as any[],
    setModeCalls: [] as any[],
    setModelCalls: [] as any[],
    nextPromptError: null as any,
    nextPromptResult: { stopReason: "end" } as any,
  };

  class ClientSideConnection {
    client: any;
    constructor(clientFactory: any) {
      this.client = clientFactory();
    }

    async initialize() {
      return testing.initializeResponse;
    }

    async authenticate(params: any) {
      testing.authenticateCalls.push(params);
      return {};
    }

    async newSession(params: any) {
      testing.newSessionCalls.push(params);
      return { sessionId: `s${testing.newSessionCalls.length}`, modes: { currentModeId: "mode1" }, models: { currentModelId: "model1" } };
    }

    async loadSession(params: any) {
      testing.loadSessionCalls.push(params);
      return { modes: { currentModeId: "mode1" }, models: { currentModelId: "model1" } };
    }

    async prompt(params: any) {
      testing.promptCalls.push(params);
      const err = testing.nextPromptError;
      if (err) {
        testing.nextPromptError = null;
        throw err;
      }
      return testing.nextPromptResult;
    }

    async cancel(params: any) {
      testing.cancelCalls.push(params);
      return {};
    }

    async setSessionMode(params: any) {
      testing.setModeCalls.push(params);
      return {};
    }

    async setSessionModel(params: any) {
      testing.setModelCalls.push(params);
      return {};
    }
  }

  return {
    PROTOCOL_VERSION: "1.0",
    RequestError,
    ClientSideConnection,
    __testing: testing,
  };
});

vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../src/modules/workflow/taskProgress.js", () => ({ advanceTaskFromRunTerminal: vi.fn() }));
vi.mock("../../src/modules/pm/pmAutoAdvance.js", () => ({ triggerPmAutoAdvance: vi.fn() }));

const { createAcpTunnel } = await import("../../src/modules/acp/acpTunnel.js");
const acp = await import("@agentclientprotocol/sdk");
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const { advanceTaskFromRunTerminal } = await import("../../src/modules/workflow/taskProgress.js");

describe("acpTunnel (full)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (acp as any).__testing.nextPromptError = null;
    (acp as any).__testing.nextPromptResult = { stopReason: "end" };
    (acp as any).__testing.newSessionCalls.length = 0;
    (acp as any).__testing.loadSessionCalls.length = 0;
    (acp as any).__testing.promptCalls.length = 0;
    (acp as any).__testing.authenticateCalls.length = 0;
    (acp as any).__testing.cancelCalls.length = 0;
    (acp as any).__testing.setModeCalls.length = 0;
    (acp as any).__testing.setModelCalls.length = 0;

    (advanceTaskFromRunTerminal as any).mockResolvedValue({ handled: false });
    (fs.promises.readFile as any).mockResolvedValue("L1\nL2\nL3\n");
    (fs.promises.mkdir as any).mockResolvedValue(undefined);
    (fs.promises.writeFile as any).mockResolvedValue(undefined);

    (spawn as any).mockImplementation(() => {
      const proc = new EventEmitter() as any;
      proc.exitCode = null;
      proc.signalCode = null;
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      proc.kill = vi.fn(() => {
        proc.exitCode = 0;
        proc.emit("exit", 0, null);
      });
      return proc;
    });
  });

  it("promptRun opens session, creates sessionId, and persists prompt_result", async () => {
    const tunnelRef = { current: null as any };
    const prisma = {
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const sel = args?.select ?? {};
          if (sel.sandboxInstanceName) return { sandboxInstanceName: null, keepaliveTtlSeconds: null };
          if (sel.metadata) return { metadata: {}, acpSessionId: null };
          if (sel.status) return { id: "r1", status: "running", issueId: "i1", agentId: "a1", taskId: null, stepId: null, metadata: {} };
          return null;
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      issue: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agent: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, { run_id: payload.run_id, ok: true });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent, broadcastToClients: vi.fn() });
    tunnelRef.current = tunnel;

    const res = await tunnel.promptRun({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "/workspace",
      context: "CTX",
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(res).toEqual({ sessionId: "s1", stopReason: "end" });
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "acp_open",
        run_id: "r1",
        cwd: "/workspace",
        instance_name: expect.any(String),
        keepalive_ttl_seconds: expect.any(Number),
      }),
    );
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: expect.objectContaining({ acpSessionId: "s1" }) });
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: "r1",
          type: "acp.update.received",
          payload: { type: "prompt_result", stopReason: "end" },
        }),
      }),
    );
  });

  it("withAuthRetry authenticates and retries when code=-32000", async () => {
    const tunnelRef = { current: null as any };
    const prisma = {
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const sel = args?.select ?? {};
          if (sel.sandboxInstanceName) return { sandboxInstanceName: null, keepaliveTtlSeconds: null };
          if (sel.metadata) return { metadata: {}, acpSessionId: null };
          if (sel.status) return { id: "r1", status: "completed", issueId: "i1", agentId: null, taskId: null, stepId: null, metadata: {} };
          return null;
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      issue: { updateMany: vi.fn() },
      agent: { update: vi.fn() },
    } as any;

    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, { run_id: payload.run_id, ok: true });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    (acp as any).__testing.nextPromptError = { code: -32000 };
    const p = tunnel.promptRun({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", prompt: [{ type: "text", text: "hi" }] });

    // first call fails with auth required; second call succeeds after authenticate
    await expect(p).resolves.toEqual({ sessionId: "s1", stopReason: "end" });
    expect((acp as any).__testing.authenticateCalls).toEqual([{ methodId: "m1" }]);
    expect((acp as any).__testing.promptCalls).toHaveLength(2);
  });

  it("recreates session when prompt throws session error", async () => {
    const tunnelRef = { current: null as any };
    const prisma = {
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const sel = args?.select ?? {};
          if (sel.sandboxInstanceName) return { sandboxInstanceName: null, keepaliveTtlSeconds: null };
          if (sel.metadata) return { metadata: {}, acpSessionId: null };
          if (sel.status) return { id: "r1", status: "completed", issueId: "i1", agentId: null, taskId: null, stepId: null, metadata: {} };
          return null;
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      issue: { updateMany: vi.fn() },
      agent: { update: vi.fn() },
    } as any;

    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, { run_id: payload.run_id, ok: true });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    (acp as any).__testing.nextPromptError = new Error("Session not found");

    const res = await tunnel.promptRun({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "/workspace",
      context: "CTX",
      prompt: [{ type: "text", text: "hello" }],
    });

    expect(res.sessionId).toBe("s2");
    expect((acp as any).__testing.newSessionCalls).toHaveLength(2);
    expect((acp as any).__testing.promptCalls).toHaveLength(2);
  });

  it("supports cancelSession / setSessionMode / setSessionModel", async () => {
    const tunnelRef = { current: null as any };
    const prisma = {
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const sel = args?.select ?? {};
          if (sel.sandboxInstanceName) return { sandboxInstanceName: null, keepaliveTtlSeconds: null };
          if (sel.metadata) return { metadata: {}, acpSessionId: "s1" };
          return null;
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, { run_id: payload.run_id, ok: true });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    await tunnel.cancelSession({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1" });
    await tunnel.setSessionMode({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1", modeId: "m2" });
    await tunnel.setSessionModel({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1", modelId: "gpt" });

    expect((acp as any).__testing.cancelCalls).toEqual([{ sessionId: "s1" }]);
    expect((acp as any).__testing.setModeCalls).toEqual([{ sessionId: "s1", modeId: "m2" }]);
    expect((acp as any).__testing.setModelCalls).toEqual([{ sessionId: "s1", modelId: "gpt" }]);
  });

  it("exposes client fs/terminal helpers through runStates", async () => {
    const tunnelRef = { current: null as any };
    const prisma = {
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const sel = args?.select ?? {};
          if (sel.sandboxInstanceName) return { sandboxInstanceName: null, keepaliveTtlSeconds: null };
          if (sel.metadata) return { metadata: {}, acpSessionId: null };
          return null;
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
      issue: { updateMany: vi.fn() },
      agent: { update: vi.fn() },
    } as any;

    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, { run_id: payload.run_id, ok: true });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;
    await tunnel.promptRun({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", prompt: [{ type: "text", text: "hi" }] });

    const state = tunnel.__testing.runStates.get("r1");
    expect(state).toBeTruthy();

    const client = state.conn.client;

    const readAll = await client.readTextFile({ path: "a.txt" });
    expect(readAll).toEqual({ content: "L1\nL2\nL3\n" });

    const readSlice = await client.readTextFile({ path: "a.txt", line: 2, limit: 1 });
    expect(readSlice).toEqual({ content: "L2" });

    await client.writeTextFile({ path: "dir/out.txt", content: "X" });
    expect(fs.promises.mkdir).toHaveBeenCalled();
    expect(fs.promises.writeFile).toHaveBeenCalledWith(expect.stringContaining("dir"), "X", "utf8");

    await expect(client.createTerminal({ sessionId: "s1", command: "", args: [] })).rejects.toMatchObject({ code: -32602 });

    const { terminalId } = await client.createTerminal({
      sessionId: "s1",
      cwd: "/workspace",
      command: "pnpm",
      args: ["test"],
      env: [{ name: "A", value: "1" }],
      outputByteLimit: 4096,
    });

    const termState = state.terminals.get(terminalId);
    expect(termState).toBeTruthy();

    // feed some output and exit
    (termState as any).exitStatus = { exitCode: 0, signal: null };
    const out = await client.terminalOutput({ terminalId });
    expect(out).toEqual({ output: "", truncated: false, exitStatus: { exitCode: 0, signal: null } });

    await client.releaseTerminal({ terminalId });
    expect(state.terminals.has(terminalId)).toBe(false);
  });
});
