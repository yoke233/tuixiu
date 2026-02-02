import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import type { ProcessHandle } from "../sandbox/types.js";
import { RunManager } from "../runs/runManager.js";
import type { ProxySandbox } from "../sandbox/ProxySandbox.js";
import { createPlatform } from "../platform/createPlatform.js";

import { handleAcpOpen } from "./handleAcpOpen.js";
import { handlePromptSend } from "./handlePromptSend.js";

function createHarness() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const received: any[] = [];
  let buf = "";

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      buf += decoder.decode(chunk, { stream: true });
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        received.push(JSON.parse(line));
      }
    },
  });

  const stdoutTs = new TransformStream<Uint8Array, Uint8Array>();
  const stdoutWriter = stdoutTs.writable.getWriter();

  const stderrTs = new TransformStream<Uint8Array, Uint8Array>();
  const stderrWriter = stderrTs.writable.getWriter();

  const handle: ProcessHandle = {
    stdin,
    stdout: stdoutTs.readable,
    stderr: stderrTs.readable,
    close: async () => {},
    onExit: () => {},
  };

  return {
    received,
    handle,
    sendStdout: async (obj: unknown) => {
      await stdoutWriter.write(encoder.encode(`${JSON.stringify(obj)}\n`));
    },
    sendStderrLine: async (text: string) => {
      await stderrWriter.write(encoder.encode(`${text}\n`));
    },
  };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = get();
    if (v !== undefined) return v;
    await delay(10);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

function baseConfig(): any {
  return {
    orchestrator_url: "ws://127.0.0.1:0",
    auth_token: "",
    heartbeat_seconds: 1,
    mock_mode: false,
    sandbox: {
      terminalEnabled: true,
      provider: "boxlite_oci",
      image: "img",
      workingDir: "/workspace",
      workspaceHostRoot: "C:/tmp",
    },
    agent_command: ["node", "-e", "console.log('ok')"],
    agent: { id: "a1", name: "a1", max_concurrent: 1, capabilities: {} },
  };
}

describe("proxy/handlers", () => {
  it("handleAcpOpen: opens agent + initialize then replies acp_opened(ok)", async () => {
    const h = createHarness();
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "running",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: async () => [],
      stopInstance: async () => {},
      removeInstance: async () => {},
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => ({ handle: h.handle, created: true, initPending: false }),
    };

    const cfg = baseConfig();
    const ctx = {
      cfg,
      sandbox,
      platform: createPlatform(cfg),
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    const p = handleAcpOpen(ctx as any, {
      type: "acp_open",
      run_id: "r1",
      init: {
        script: "",
        env: { USER_HOME: "/root" },
        agentInputs: { version: 1, items: [] },
      },
    });

    const initReq = await waitFor(() => h.received.find((m) => m.method === "initialize"), 2_000);
    await h.sendStdout({
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      },
    });

    await p;

    expect(messages).toContainEqual({ type: "acp_opened", run_id: "r1", ok: true });
  });

  it("handlePromptSend: forwards session/update as prompt_update and replies prompt_result(ok)", async () => {
    const h = createHarness();
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "running",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: async () => [],
      stopInstance: async () => {},
      removeInstance: async () => {},
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => ({ handle: h.handle, created: true, initPending: false }),
    };

    const cfg = baseConfig();
    const ctx = {
      cfg,
      sandbox,
      platform: createPlatform(cfg),
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    const p = handlePromptSend(ctx as any, {
      type: "prompt_send",
      run_id: "r1",
      prompt_id: "p1",
      prompt: [{ type: "text", text: "1+1=?" }],
    });

    const initReq = await waitFor(() => h.received.find((m) => m.method === "initialize"), 2_000);
    await h.sendStdout({
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      },
    });

    const newReq = await waitFor(() => h.received.find((m) => m.method === "session/new"), 2_000);
    await h.sendStdout({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "s1" } });

    const promptReq = await waitFor(
      () => h.received.find((m) => m.method === "session/prompt"),
      2_000,
    );
    await h.sendStdout({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "session_created", content: { type: "session_created" } },
      },
    });
    await h.sendStdout({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "2" } },
      },
    });
    await h.sendStdout({
      jsonrpc: "2.0",
      id: promptReq.id,
      result: { stopReason: "end_turn" },
    });

    await p;

    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "prompt_update" &&
          (m as any).run_id === "r1" &&
          (m as any).prompt_id === "p1" &&
          (m as any).update?.sessionUpdate === "agent_message_chunk" &&
          (m as any).update?.content?.text === "2",
      ),
    ).toBe(true);

    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "agent_update" &&
          (m as any).run_id === "r1" &&
          (m as any).content?.type === "session_created" &&
          (m as any).content?.session_id === "s1",
      ),
    ).toBe(true);

    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "prompt_result" &&
          (m as any).run_id === "r1" &&
          (m as any).prompt_id === "p1" &&
          (m as any).ok === true &&
          (m as any).session_id === "s1" &&
          (m as any).stop_reason === "end_turn",
      ),
    ).toBe(true);
  });

  it("handlePromptSend uses per-run cwd for git_clone (workspace/run-)", async () => {
    const h = createHarness();
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "running",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: async () => [],
      stopInstance: async () => {},
      removeInstance: async () => {},
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => ({ handle: h.handle, created: true, initPending: false }),
    };

    const cfg = { ...baseConfig(), sandbox: { ...baseConfig().sandbox, workspaceMode: "git_clone" } };
    const ctx = {
      cfg,
      sandbox,
      platform: createPlatform(cfg),
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    const p = handlePromptSend(ctx as any, {
      type: "prompt_send",
      run_id: "r1",
      prompt_id: "p1",
      prompt: [{ type: "text", text: "1+1=?" }],
    });

    const initReq = await waitFor(() => h.received.find((m) => m.method === "initialize"), 2_000);
    await h.sendStdout({
      jsonrpc: "2.0",
      id: initReq.id,
      result: {
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      },
    });

    const newReq = await waitFor(() => h.received.find((m) => m.method === "session/new"), 2_000);
    expect(newReq?.params?.cwd).toBe("/workspace/run-r1");
    await h.sendStdout({ jsonrpc: "2.0", id: newReq.id, result: { sessionId: "s1" } });

    const promptReq = await waitFor(
      () => h.received.find((m) => m.method === "session/prompt"),
      2_000,
    );
    await h.sendStdout({ jsonrpc: "2.0", id: promptReq.id, result: { stopReason: "end_turn" } });

    await p;

    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "prompt_result" &&
          (m as any).run_id === "r1" &&
          (m as any).ok === true,
      ),
    ).toBe(true);
  });
});
