import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { makeGitHubWebhookRoutes } from "../../src/routes/githubWebhooks.js";
import { createHttpServer } from "../test-utils.js";

function sign(secret: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(Buffer.from(rawBody)).digest("hex")}`;
}

describe("GitHub webhook routes", () => {
  it("POST /api/webhooks/github accepts ping when signature ok", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([]) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/webhooks" });

    const raw = JSON.stringify({ hook_id: 1 });
    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": sign("s3cret", raw)
      },
      payload: raw
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, event: "ping" } });

    await server.close();
  });

  it("POST /api/webhooks/github rejects when signature mismatch", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([]) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/webhooks" });

    const raw = JSON.stringify({ hello: "world" });
    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef"
      },
      payload: raw
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_SIGNATURE", message: "GitHub webhook 签名校验失败" }
    });

    await server.close();
  });

  it("POST /api/webhooks/github ignores unsupported event", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([]) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "installation" },
      payload: { any: "thing" }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, ignored: true, reason: "UNSUPPORTED_EVENT", event: "installation" } });
    await server.close();
  });

  it("POST /api/webhooks/github handles workflow_run completed and updates waiting_ci run", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }])
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "r1", issueId: "i1", taskId: null, stepId: null }),
        findUnique: vi.fn().mockResolvedValue({ id: "r1" }),
        update: vi.fn().mockResolvedValue({})
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "a1" }) }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "completed",
      workflow_run: {
        head_branch: "run/xyz",
        head_sha: "abc",
        status: "completed",
        conclusion: "success"
      },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "workflow_run" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, handled: true, runId: "r1", passed: true } });
    expect(prisma.artifact.create).not.toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ status: "completed", scmProvider: "github", scmCiStatus: "passed", scmHeadSha: "abc" })
      })
    );

    await server.close();
  });

  it("POST /api/webhooks/github handles check_suite completed and resolves run by scmPrNumber", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }])
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "r1", issueId: "i1", taskId: null, stepId: null }),
        update: vi.fn().mockResolvedValue({})
      }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "completed",
      check_suite: {
        head_branch: "",
        head_sha: "abc",
        status: "completed",
        conclusion: "success",
        pull_requests: [{ number: 123 }]
      },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "check_suite" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, handled: true, runId: "r1", passed: true } });
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "waiting_ci",
          scmProvider: "github",
          scmPrNumber: { in: [123] },
        }),
      }),
    );
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({ status: "completed", scmProvider: "github", scmCiStatus: "passed", scmHeadSha: "abc" }),
      }),
    );

    await server.close();
  });

  it("POST /api/webhooks/github returns BAD_PAYLOAD when body invalid", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([]) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "issues" },
      payload: { nope: true }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法" })
      })
    );
    await server.close();
  });

  it("POST /api/webhooks/github imports issue on opened", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }])
      },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "i1" })
      }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma, webhookSecret: "s3cret" }), { prefix: "/api/webhooks" });

    const payload = {
      action: "opened",
      issue: {
        id: 11,
        number: 3,
        title: "Hello",
        body: "World",
        state: "open",
        html_url: "https://github.com/o/r/issues/3",
        labels: [{ name: "bug" }]
      },
      repository: { html_url: "https://github.com/o/r" }
    };
    const raw = JSON.stringify(payload);

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": sign("s3cret", raw)
      },
      payload: raw
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, projectId: "p1", issueId: "i1", created: true } });

    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          title: "Hello",
          externalProvider: "github",
          externalId: "11",
          externalNumber: 3,
          externalUrl: "https://github.com/o/r/issues/3",
          createdBy: "github_webhook"
        })
      })
    );

    await server.close();
  });

  it("POST /api/webhooks/github returns NO_PROJECT when repo does not match any project", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/other/r" }]) },
      issue: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "opened",
      issue: { id: 11, number: 3, title: "Hello", body: "World", state: "open", html_url: "https://github.com/o/r/issues/3" },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "issues" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project" })
      })
    );

    await server.close();
  });

  it("POST /api/webhooks/github updates existing issue (reopened -> pending)", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }])
      },
      issue: {
        findFirst: vi.fn().mockResolvedValue({ id: "i1", status: "done" }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "reopened",
      issue: { id: 11, number: 3, title: "Hello", body: null, state: "open", html_url: "https://github.com/o/r/issues/3", labels: [] },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "issues" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, projectId: "p1", issueId: "i1", created: false } });

    expect(prisma.issue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "i1" },
        data: expect.objectContaining({ status: "pending" })
      })
    );

    await server.close();
  });

  it("POST /api/webhooks/github treats duplicate create as idempotent", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r" }])
      },
      issue: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "i1" }),
        create: vi.fn().mockRejectedValue(new Error("dup"))
      }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "opened",
      issue: { id: 11, number: 3, title: "Hello", body: "World", state: "open", html_url: "https://github.com/o/r/issues/3" },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "issues" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true, projectId: "p1", issueId: "i1", created: false } });

    await server.close();
  });

  it("POST /api/webhooks/github ignores non-open action when issue missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }])
      },
      issue: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() }
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "edited",
      issue: { id: 11, number: 3, title: "Hello", body: "World", state: "open", html_url: "https://github.com/o/r/issues/3" },
      repository: { html_url: "https://github.com/o/r" }
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "issues" },
      payload
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { ok: true, ignored: true, reason: "NOT_OPEN_ACTION", action: "edited" }
    });
    expect(prisma.issue.create).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/webhooks/github handles pull_request and updates run scm state", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }]) },
      run: {
        findFirst: vi.fn().mockResolvedValue({ id: "r1", issueId: "i1", taskId: null }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "opened",
      pull_request: {
        number: 123,
        html_url: "https://github.com/o/r/pull/123",
        state: "open",
        title: "PR",
        body: "desc",
        head: { ref: "run/xyz", sha: "abc" },
        base: { ref: "main" },
        draft: false,
      },
      repository: { html_url: "https://github.com/o/r" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "pull_request" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ ok: true, handled: true, event: "pull_request", prNumber: 123, headSha: "abc" }),
      }),
    );
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({
          scmProvider: "github",
          scmPrNumber: 123,
          scmPrUrl: "https://github.com/o/r/pull/123",
          scmPrState: "open",
          scmHeadSha: "abc",
        }),
      }),
    );
    await server.close();
  });

  it("POST /api/webhooks/github handles pull_request_review changes_requested and blocks task", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }]) },
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const id = String(args?.where?.id ?? "");
          if (id === "mergeRun") {
            return {
              id: "mergeRun",
              taskId: "t1",
              stepId: "s1",
              task: { id: "t1", issueId: "i1", steps: [] },
              step: { id: "s1", kind: "pr.merge" },
            };
          }
          return null;
        }),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: "r1", issueId: "i1", taskId: "t1" })
          .mockResolvedValueOnce({ id: "mergeRun" }),
        update: vi.fn().mockResolvedValue({}),
      },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "submitted",
      review: { state: "changes_requested", body: "pls fix" },
      pull_request: {
        number: 123,
        html_url: "https://github.com/o/r/pull/123",
        head: { ref: "run/xyz", sha: "abc" },
        base: { ref: "main" },
      },
      repository: { html_url: "https://github.com/o/r" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "pull_request_review" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ ok: true, handled: true, event: "pull_request_review", prNumber: 123, reviewState: "changes_requested" }),
      }),
    );
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" }, data: { status: "blocked" } }));
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1" }, data: { status: "reviewing" } }));
    await server.close();
  });

  it("POST /api/webhooks/github handles pull_request merged and completes pr.merge run", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1", repoUrl: "https://github.com/o/r", scmType: "github" }]) },
      run: {
        findUnique: vi.fn().mockImplementation(async (args: any) => {
          const id = String(args?.where?.id ?? "");
          if (id === "mergeRun") {
            return {
              id: "mergeRun",
              taskId: "t1",
              stepId: "s1",
              executorType: "human",
              task: { id: "t1", issueId: "i1", steps: [{ id: "s1", kind: "pr.merge", order: 1, status: "waiting_human" }] },
              step: { id: "s1", kind: "pr.merge", order: 1 },
            };
          }
          return null;
        }),
        findFirst: vi.fn().mockResolvedValue({ id: "r1", issueId: "i1", taskId: "t1" }),
        findMany: vi.fn().mockResolvedValue([{ id: "mergeRun", issueId: "i1", taskId: "t1", stepId: "s1" }]),
        update: vi.fn().mockResolvedValue({}),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    await server.register(makeGitHubWebhookRoutes({ prisma }), { prefix: "/api/webhooks" });

    const payload = {
      action: "closed",
      pull_request: {
        number: 123,
        html_url: "https://github.com/o/r/pull/123",
        state: "closed",
        merged: true,
        head: { ref: "run/xyz", sha: "abc" },
        base: { ref: "main" },
      },
      repository: { html_url: "https://github.com/o/r" },
    };

    const res = await server.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "pull_request" },
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ handled: true, merged: true }) }));
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "mergeRun" },
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1" }, data: { status: "done" } }));
    await server.close();
  });
});
