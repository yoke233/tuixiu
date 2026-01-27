import { describe, expect, it, vi } from "vitest";

import { makeCodeupWebhookRoutes } from "../../src/routes/codeupWebhooks.js";
import { createHttpServer } from "../test-utils.js";

describe("Codeup webhook routes", () => {
  it("POST /api/webhooks/codeup returns BAD_PAYLOAD when body invalid", async () => {
    const server = createHttpServer();
    const prisma = { project: { findMany: vi.fn() } } as any;

    await server.register(makeCodeupWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/codeup",
      payload: [],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法" }),
      }),
    );

    await server.close();
  });

  it("POST /api/webhooks/codeup rejects when token mismatch", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://codeup.aliyun.com/demo/demo.git" }]) },
    } as any;

    await server.register(makeCodeupWebhookRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/webhooks" });

    const payload = {
      object_kind: "merge_request",
      repository: { git_http_url: "https://codeup.aliyun.com/demo/demo.git" },
      object_attributes: { source_branch: "run/xyz", action: "merge", state: "merged" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/codeup",
      headers: { "x-codeup-token": "bad", "codeup-event": "Merge Request Hook" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_TOKEN", message: "Codeup webhook token 校验失败" } });
    await server.close();
  });

  it("POST /api/webhooks/codeup marks merge step run completed on merged merge_request", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://codeup.aliyun.com/demo/demo.git" }]) },
      run: {
        findMany: vi.fn().mockResolvedValue([{ id: "r1", issueId: "i1", taskId: "t1", stepId: "s1" }]),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await server.register(makeCodeupWebhookRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/webhooks" });

    const payload = {
      object_kind: "merge_request",
      repository: { git_http_url: "https://codeup.aliyun.com/demo/demo.git" },
      object_attributes: { source_branch: "run/xyz", action: "merge", state: "merged" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/codeup",
      headers: { "x-codeup-token": "s3cret", "codeup-event": "Merge Request Hook" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, handled: true, merged: true, runsUpdated: 1 } });
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );

    await server.close();
  });
});

