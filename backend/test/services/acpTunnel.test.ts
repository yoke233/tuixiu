import { describe, expect, it, vi } from "vitest";

import { createAcpTunnel } from "../../src/modules/acp/acpTunnel.js";

describe("acpTunnel", () => {
  it("rejects promptRun when acp_open times out", async () => {
    vi.useFakeTimers();

    const prev = process.env.ACP_OPEN_TIMEOUT_MS;
    process.env.ACP_OPEN_TIMEOUT_MS = "10";

    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    const tunnel = createAcpTunnel({
      prisma,
      sendToAgent: vi.fn().mockResolvedValue(undefined),
      broadcastToClients: vi.fn(),
    });

    const p = tunnel.promptRun({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "c1",
      prompt: "hi",
    });

    const assertion = expect(p).rejects.toThrow(/acp_open timeout/i);
    await vi.advanceTimersByTimeAsync(20);
    await assertion;

    if (prev === undefined) {
      delete process.env.ACP_OPEN_TIMEOUT_MS;
    } else {
      process.env.ACP_OPEN_TIMEOUT_MS = prev;
    }
    vi.useRealTimers();
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

    const tunnel = createAcpTunnel({
      prisma,
      sendToAgent: vi.fn(),
      broadcastToClients: vi.fn(),
    });

    await tunnel.__testing.persistSessionUpdate("r1", "s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello " },
    } as any);

    await tunnel.__testing.persistSessionUpdate("r1", "s1", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
    } as any);

    await tunnel.__testing.flushRunChunkBuffer("r1");

    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    const payload = prisma.event.create.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({
      type: "session_update",
      session: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" },
      },
    });
  });
});

