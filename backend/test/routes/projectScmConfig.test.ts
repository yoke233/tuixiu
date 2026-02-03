import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeProjectScmConfigRoutes } from "../../src/routes/projectScmConfig.js";
import { createHttpServer } from "../test-utils.js";

describe("ProjectScmConfig routes", () => {
  it("GET /api/projects/:projectId/scm-config returns defaults when missing", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }) },
      projectScmConfig: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeProjectScmConfigRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "dev" });
    const res = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/scm-config",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        scmConfig: {
          projectId: "00000000-0000-0000-0000-000000000001",
          gitlabProjectId: null,
          hasGitlabWebhookSecret: false,
          githubPollingEnabled: false,
          githubPollingCursor: null,
        },
      },
    });

    await server.close();
  });

  it("PUT /api/projects/:projectId/scm-config returns FORBIDDEN for non-admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      project: { findUnique: vi.fn() },
      projectScmConfig: { upsert: vi.fn() },
    } as any;

    await server.register(makeProjectScmConfigRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "pm" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/scm-config",
      headers: { authorization: `Bearer ${token}` },
      payload: { gitlabProjectId: 123, gitlabWebhookSecret: "secret", githubPollingEnabled: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
    expect(prisma.projectScmConfig.upsert).not.toHaveBeenCalled();

    await server.close();
  });

  it("PUT /api/projects/:projectId/scm-config upserts and returns redacted config", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }) },
      projectScmConfig: {
        upsert: vi.fn().mockResolvedValue({
          id: "c1",
          projectId: "00000000-0000-0000-0000-000000000001",
          gitlabProjectId: 123,
          gitlabWebhookSecret: "secret",
          githubPollingEnabled: true,
          githubPollingCursor: null,
        }),
      },
    } as any;

    await server.register(makeProjectScmConfigRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/scm-config",
      headers: { authorization: `Bearer ${token}` },
      payload: { gitlabProjectId: 123, gitlabWebhookSecret: "secret", githubPollingEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        scmConfig: {
          projectId: "00000000-0000-0000-0000-000000000001",
          gitlabProjectId: 123,
          hasGitlabWebhookSecret: true,
          githubPollingEnabled: true,
          githubPollingCursor: null,
        },
      },
    });

    expect(prisma.projectScmConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "00000000-0000-0000-0000-000000000001" },
        create: expect.objectContaining({
          projectId: "00000000-0000-0000-0000-000000000001",
          gitlabProjectId: 123,
          gitlabWebhookSecret: "secret",
          githubPollingEnabled: true,
        }),
        update: {
          gitlabProjectId: 123,
          gitlabWebhookSecret: "secret",
          githubPollingEnabled: true,
        },
      }),
    );

    await server.close();
  });
});

