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
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, {
          run_id: payload.run_id,
          ok: true,
        });
        return;
      }
      if (payload.type === "prompt_send") {
        tunnelRef.current.gatewayHandlers.handlePromptResult(proxyId, {
          run_id: payload.run_id,
          prompt_id: payload.prompt_id,
          ok: true,
          session_id: "s1",
          stop_reason: "end",
        });
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

  it("promptRun forwards session_id when provided", async () => {
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

    let promptPayload: any = null;
    const sendToAgent = vi.fn().mockImplementation(async (proxyId: string, payload: any) => {
      if (payload.type === "acp_open") {
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, {
          run_id: payload.run_id,
          ok: true,
        });
        return;
      }
      if (payload.type === "prompt_send") {
        promptPayload = payload;
        tunnelRef.current.gatewayHandlers.handlePromptResult(proxyId, {
          run_id: payload.run_id,
          prompt_id: payload.prompt_id,
          ok: true,
          session_id: "s1",
          stop_reason: "end",
        });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    const res = await tunnel.promptRun({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "/workspace",
      sessionId: "s-hint",
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(res).toEqual({ sessionId: "s1", stopReason: "end" });
    expect(promptPayload?.session_id).toBe("s-hint");
  });

  it("promptRun rejects when prompt_result fails", async () => {
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
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, {
          run_id: payload.run_id,
          ok: true,
        });
        return;
      }
      if (payload.type === "prompt_send") {
        tunnelRef.current.gatewayHandlers.handlePromptResult(proxyId, {
          run_id: payload.run_id,
          prompt_id: payload.prompt_id,
          ok: false,
          error: "prompt_failed",
        });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    await expect(
      tunnel.promptRun({
        proxyId: "proxy-1",
        runId: "r1",
        cwd: "/workspace",
        context: "CTX",
        prompt: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toThrow("prompt_failed");
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
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, {
          run_id: payload.run_id,
          ok: true,
        });
        return;
      }
      if (
        payload.type === "session_cancel" ||
        payload.type === "session_set_mode" ||
        payload.type === "session_set_model"
      ) {
        tunnelRef.current.gatewayHandlers.handleSessionControlResult(proxyId, {
          run_id: payload.run_id,
          control_id: payload.control_id,
          ok: true,
        });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;

    await tunnel.cancelSession({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1" });
    await tunnel.setSessionMode({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1", modeId: "m2" });
    await tunnel.setSessionModel({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", sessionId: "s1", modelId: "gpt" });

    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({ type: "session_cancel", session_id: "s1" }),
    );
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({ type: "session_set_mode", mode_id: "m2" }),
    );
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({ type: "session_set_model", model_id: "gpt" }),
    );
  });

  it("stores run state after promptRun", async () => {
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
        tunnelRef.current.gatewayHandlers.handleAcpOpened(proxyId, {
          run_id: payload.run_id,
          ok: true,
        });
        return;
      }
      if (payload.type === "prompt_send") {
        tunnelRef.current.gatewayHandlers.handlePromptResult(proxyId, {
          run_id: payload.run_id,
          prompt_id: payload.prompt_id,
          ok: true,
          session_id: "s1",
          stop_reason: "end",
        });
      }
    });

    const tunnel = createAcpTunnel({ prisma, sendToAgent });
    tunnelRef.current = tunnel;
    await tunnel.promptRun({ proxyId: "proxy-1", runId: "r1", cwd: "/workspace", prompt: [{ type: "text", text: "hi" }] });

    const state = tunnel.__testing.runStates.get("r1");
    expect(state).toBeTruthy();
    expect(state?.opened).toBe(true);
    expect(state?.promptDeferredById.size).toBe(0);
  });
});
