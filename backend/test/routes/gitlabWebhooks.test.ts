import { describe, expect, it, vi } from "vitest";

import { makeGitLabWebhookRoutes } from "../../src/routes/gitlabWebhooks.js";
import { createHttpServer } from "../test-utils.js";

describe("GitLab webhook routes", () => {
  it("POST /api/webhooks/gitlab returns BAD_PAYLOAD when body invalid", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn() },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    } as any;

    await server.register(makeGitLabWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      payload: { nope: true },
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

  it("POST /api/webhooks/gitlab imports issue on open", async () => {
    const server = createHttpServer();
    const onIssueUpserted = vi.fn();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1", gitlabProjectId: 123 }) },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "i1" }),
      },
    } as any;

    await server.register(makeGitLabWebhookRoutes({ prisma, onIssueUpserted, webhookSecret: "s3cret" }), {
      prefix: "/api/webhooks",
    });

    const payload = {
      object_kind: "issue",
      project: { id: 123, web_url: "https://gitlab.example.com/group/repo" },
      object_attributes: {
        id: 999,
        iid: 7,
        title: "Hello",
        description: "World",
        state: "opened",
        action: "open",
        url: "https://gitlab.example.com/group/repo/-/issues/7",
      },
      labels: [{ title: "bug" }],
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      headers: { "x-gitlab-token": "s3cret", "x-gitlab-event": "Issue Hook" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, projectId: "p1", issueId: "i1", created: true } });

    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          title: "Hello",
          externalProvider: "gitlab",
          externalId: "999",
          externalNumber: 7,
          externalUrl: "https://gitlab.example.com/group/repo/-/issues/7",
          createdBy: "gitlab_webhook",
        }),
      }),
    );
    expect(onIssueUpserted).toHaveBeenCalledWith("i1", "gitlab_webhook:open");

    await server.close();
  });

  it("POST /api/webhooks/gitlab rejects when token mismatch", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1", gitlabProjectId: 123, gitlabWebhookSecret: "s3cret" }) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    } as any;

    await server.register(makeGitLabWebhookRoutes({ prisma, webhookSecret: "ignored" }), { prefix: "/api/webhooks" });

    const payload = {
      object_kind: "issue",
      project: { id: 123, web_url: "https://gitlab.example.com/group/repo" },
      object_attributes: { id: 1, iid: 1, title: "Hello", action: "open", url: "u" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      headers: { "x-gitlab-token": "bad" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_TOKEN", message: "GitLab webhook token 校验失败" } });
    await server.close();
  });
});

