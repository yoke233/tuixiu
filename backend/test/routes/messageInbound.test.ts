import { describe, expect, it, vi } from "vitest";

import { makeMessageInboundRoutes } from "../../src/routes/messageInbound.js";
import { createHttpServer } from "../test-utils.js";

describe("Message inbound routes", () => {
  it("POST /api/integrations/messages/inbound rejects when token mismatch", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn() },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    } as any;

    await server.register(makeMessageInboundRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/integrations" });

    const res = await server.inject({
      method: "POST",
      url: "/api/integrations/messages/inbound",
      headers: { "x-webhook-token": "bad" },
      payload: { title: "t1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_TOKEN", message: "消息入口 token 校验失败" } });
    await server.close();
  });

  it("POST /api/integrations/messages/inbound creates issue and triggers callback", async () => {
    const server = createHttpServer();
    const onIssueUpserted = vi.fn();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: { create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }) },
    } as any;

    await server.register(
      makeMessageInboundRoutes({ prisma, webhookSecret: "s3cret", onIssueUpserted }),
      { prefix: "/api/integrations" },
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/integrations/messages/inbound",
      headers: { "x-webhook-token": "s3cret" },
      payload: { title: "t1", description: "d1", labels: ["bug"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", title: "t1" }, created: true } });
    expect(onIssueUpserted).toHaveBeenCalledWith("i1", "message_inbound");
    await server.close();
  });
});

