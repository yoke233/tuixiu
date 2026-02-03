import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeGitCredentialRoutes } from "../../src/routes/gitCredentials.js";
import { createHttpServer } from "../test-utils.js";

describe("GitCredential routes", () => {
  it("GET /api/projects/:projectId/git-credentials returns redacted list", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      gitCredential: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000100",
            projectId: "00000000-0000-0000-0000-000000000001",
            key: "run-default",
            purpose: "run",
            gitAuthMode: "https_pat",
            githubAccessToken: "ghp_secret",
            gitlabAccessToken: "",
            gitSshKey: "ssh-rsa AAA",
            gitSshKeyB64: null,
            updatedAt: new Date("2026-02-03T00:00:00.000Z"),
          },
        ]),
      },
    } as any;

    await server.register(makeGitCredentialRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "dev" });
    const res = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/git-credentials",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        credentials: [
          {
            id: "00000000-0000-0000-0000-000000000100",
            projectId: "00000000-0000-0000-0000-000000000001",
            key: "run-default",
            purpose: "run",
            gitAuthMode: "https_pat",
            hasGithubAccessToken: true,
            hasGitlabAccessToken: false,
            hasSshKey: true,
            updatedAt: "2026-02-03T00:00:00.000Z",
          },
        ],
      },
    });

    expect(prisma.gitCredential.findMany).toHaveBeenCalledWith({
      where: { projectId: "00000000-0000-0000-0000-000000000001" },
      orderBy: { updatedAt: "desc" },
    });

    await server.close();
  });

  it("POST /api/projects/:projectId/git-credentials returns FORBIDDEN for non-admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      project: { findUnique: vi.fn() },
      gitCredential: { create: vi.fn() },
    } as any;

    await server.register(makeGitCredentialRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "pm" });
    const res = await server.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/git-credentials",
      headers: { authorization: `Bearer ${token}` },
      payload: { key: "run-default" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
    expect(prisma.gitCredential.create).not.toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/projects/:projectId/git-credentials/:credentialId supports clear semantics", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      gitCredential: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000100",
          projectId: "00000000-0000-0000-0000-000000000001",
        }),
        update: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000100",
          projectId: "00000000-0000-0000-0000-000000000001",
          key: "run-default",
          purpose: "run",
          gitAuthMode: "https_pat",
          githubAccessToken: null,
          gitlabAccessToken: null,
          gitSshKey: null,
          gitSshKeyB64: null,
          updatedAt: new Date("2026-02-03T00:00:00.000Z"),
        }),
      },
    } as any;

    await server.register(makeGitCredentialRoutes({ prisma, auth }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/git-credentials/00000000-0000-0000-0000-000000000100",
      headers: { authorization: `Bearer ${token}` },
      payload: { githubAccessToken: null, gitlabAccessToken: null, gitSshKey: null, gitSshKeyB64: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        credential: {
          id: "00000000-0000-0000-0000-000000000100",
          projectId: "00000000-0000-0000-0000-000000000001",
          key: "run-default",
          purpose: "run",
          gitAuthMode: "https_pat",
          hasGithubAccessToken: false,
          hasGitlabAccessToken: false,
          hasSshKey: false,
          updatedAt: "2026-02-03T00:00:00.000Z",
        },
      },
    });

    expect(prisma.gitCredential.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000100" },
      data: {
        githubAccessToken: null,
        gitlabAccessToken: null,
        gitSshKey: null,
        gitSshKeyB64: null,
      },
    });

    await server.close();
  });
});

