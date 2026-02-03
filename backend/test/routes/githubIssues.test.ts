import { describe, expect, it, vi } from "vitest";

import { makeGitHubIssueRoutes } from "../../src/routes/githubIssues.js";
import { createHttpServer } from "../test-utils.js";

describe("GitHub issues routes", () => {
  it("GET /api/projects/:id/github/issues returns NO_GITHUB_CONFIG when token missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "p1",
          repoUrl: "https://github.com/a/b",
          scmAdminCredentialId: "c-admin",
        }),
      },
      gitCredential: { findMany: vi.fn().mockResolvedValue([{ id: "c-admin", projectId: "p1", githubAccessToken: null }]) },
    } as any;

    await server.register(makeGitHubIssueRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/github/issues"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NO_GITHUB_CONFIG", message: "未配置 scmAdmin credential 的 github token" }
    });
    await server.close();
  });

  it("POST /api/projects/:id/github/issues/import returns existing issue (idempotent)", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "p1",
          repoUrl: "https://github.com/o/r",
          scmAdminCredentialId: "c-admin",
        })
      },
      gitCredential: { findMany: vi.fn().mockResolvedValue([{ id: "c-admin", projectId: "p1", githubAccessToken: "ghp_xxx" }]) },
      issue: {
        findFirst: vi.fn().mockResolvedValue({ id: "i1", title: "t1" })
      }
    } as any;

    const parseRepo = vi.fn().mockReturnValue({ apiBaseUrl: "https://api.github.com", owner: "o", repo: "r" });
    const getIssue = vi.fn().mockResolvedValue({
      id: 11,
      number: 3,
      title: "Hello",
      body: "World",
      state: "open",
      html_url: "https://github.com/o/r/issues/3",
      labels: []
    });

    await server.register(makeGitHubIssueRoutes({ prisma, parseRepo, getIssue }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/github/issues/import",
      payload: { number: 3 }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", title: "t1" }, imported: false } });
    expect(prisma.issue.findFirst).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/projects/:id/github/issues/import creates issue when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "p1",
          repoUrl: "https://github.com/o/r",
          scmAdminCredentialId: "c-admin",
        })
      },
      gitCredential: { findMany: vi.fn().mockResolvedValue([{ id: "c-admin", projectId: "p1", githubAccessToken: "ghp_xxx" }]) },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "i2", title: "Hello" })
      }
    } as any;

    const parseRepo = vi.fn().mockReturnValue({ apiBaseUrl: "https://api.github.com", owner: "o", repo: "r" });
    const getIssue = vi.fn().mockResolvedValue({
      id: 11,
      number: 3,
      title: "Hello",
      body: "World",
      state: "open",
      html_url: "https://github.com/o/r/issues/3",
      labels: [{ name: "bug" }]
    });

    await server.register(makeGitHubIssueRoutes({ prisma, parseRepo, getIssue }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000001/github/issues/import",
      payload: { url: "https://github.com/o/r/issues/3" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i2", title: "Hello" }, imported: true } });

    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "00000000-0000-0000-0000-000000000001",
          title: "Hello",
          externalProvider: "github",
          externalId: "11",
          externalNumber: 3,
          externalUrl: "https://github.com/o/r/issues/3"
        })
      })
    );

    await server.close();
  });
});
