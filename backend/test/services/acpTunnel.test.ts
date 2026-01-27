import { describe, expect, it, vi } from "vitest";

import { createAcpTunnel } from "../../src/services/acpTunnel.js";

describe("acpTunnel", () => {
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

