import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { AgentBridge } from "./agentBridge.js";

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

  return {
    received,
    handle: {
      stdin,
      stdout: stdoutTs.readable,
      stderr: stderrTs.readable,
      close: async () => {},
      onExit: () => {},
    },
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

describe("proxy/acp/AgentBridge", () => {
  it("sendRpc resolves with result", async () => {
    const h = createHarness();
    const bridge = new AgentBridge({ handle: h.handle as any });
    try {
      const p = bridge.sendRpc("initialize", { protocolVersion: 1 });
      const req = await waitFor(() => h.received.find((m) => m.method === "initialize"), 2_000);
      await h.sendStdout({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
      await expect(p).resolves.toEqual({ ok: true });
    } finally {
      await bridge.close();
    }
  });

  it("sendRpc rejects with error payload", async () => {
    const h = createHarness();
    const bridge = new AgentBridge({ handle: h.handle as any });
    try {
      const p = bridge.sendRpc("initialize", { protocolVersion: 1 });
      const req = await waitFor(() => h.received.find((m) => m.method === "initialize"), 2_000);
      await h.sendStdout({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: "auth required" },
      });
      await expect(p).rejects.toThrow(/auth required/i);
    } finally {
      await bridge.close();
    }
  });

  it("waitForInitResult resolves when marker appears on stderr", async () => {
    const h = createHarness();
    const bridge = new AgentBridge({
      handle: h.handle as any,
      init: { pending: true, markerPrefix: "__ACP_PROXY_INIT_RESULT__:" },
    });
    try {
      const p = bridge.waitForInitResult({ timeoutMs: 2_000 });
      await h.sendStderrLine('__ACP_PROXY_INIT_RESULT__:{"ok":true}');
      await expect(p).resolves.toEqual({ ok: true, exitCode: null });
    } finally {
      await bridge.close();
    }
  });
});
