import { describe, expect, it, vi } from "vitest";

import { makeProjectRoutes } from "../../src/routes/projects.js";
import { createHttpServer } from "../test-utils.js";

describe("Projects routes", () => {
  it("GET /api/projects returns list", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) },
      projectScmConfig: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            hasRunGitCredential: false,
            hasScmAdminCredential: false,
            gitlabProjectId: null,
            githubPollingEnabled: false,
            githubPollingCursor: null,
          },
        ],
      },
    });
    expect(prisma.project.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
    expect(prisma.projectScmConfig.findMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1"] } },
    });
    await server.close();
  });

  it("GET /api/projects returns credential/config summary", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([
          { id: "p1" },
        ]),
      },
      gitCredential: { findMany: vi.fn().mockResolvedValue([]) },
      projectScmConfig: {
        findMany: vi.fn().mockResolvedValue([
          {
            projectId: "p1",
            gitlabProjectId: 123,
            githubPollingEnabled: true,
            githubPollingCursor: new Date("2026-02-03T00:00:00.000Z"),
          },
        ]),
      },
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            hasRunGitCredential: false,
            hasScmAdminCredential: false,
            gitlabProjectId: 123,
            githubPollingEnabled: true,
            githubPollingCursor: "2026-02-03T00:00:00.000Z",
          },
        ],
      },
    });

    expect(prisma.project.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
    expect(prisma.projectScmConfig.findMany).toHaveBeenCalledWith({
      where: { projectId: { in: ["p1"] } },
    });

    await server.close();
  });

  it("POST /api/projects creates with defaults", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { create: vi.fn().mockResolvedValue({ id: "p2" }) }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Demo", repoUrl: "https://example.com/repo.git" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        project: {
          id: "p2",
          hasRunGitCredential: false,
          hasScmAdminCredential: false,
          gitlabProjectId: null,
          githubPollingEnabled: false,
          githubPollingCursor: null,
        },
      },
    });

    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        name: "Demo",
        repoUrl: "https://example.com/repo.git",
        scmType: "gitlab",
        defaultBranch: "main",
        workspaceMode: "worktree",
        workspacePolicy: null,
        defaultRoleKey: undefined,
        executionProfileId: undefined,
        agentWorkspaceNoticeTemplate: undefined,
        enableRuntimeSkillsMounting: false,
      }
    });
    await server.close();
  });

  it("POST /api/projects accepts workspacePolicy and executionProfileId", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { create: vi.fn().mockResolvedValue({ id: "p3" }) }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Demo",
        repoUrl: "https://example.com/repo.git",
        workspacePolicy: "empty",
        executionProfileId: "11111111-1111-1111-1111-111111111111",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspacePolicy: "empty",
        executionProfileId: "11111111-1111-1111-1111-111111111111",
      }),
    });
    await server.close();
  });

  it("POST /api/projects returns 400 on invalid body", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { create: vi.fn() }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Demo" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BAD_REQUEST" }),
      }),
    );
    expect(prisma.project.create).not.toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/projects accepts workspacePolicy", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }),
      }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000001",
      payload: { workspacePolicy: "mount" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000001" },
      data: expect.objectContaining({ workspacePolicy: "mount" }),
    });
    await server.close();
  });

  it("PATCH /api/projects allows clearing workspacePolicy", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }),
      }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000001",
      payload: { workspacePolicy: null },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000001" },
      data: expect.objectContaining({ workspacePolicy: null }),
    });
    await server.close();
  });

  it("PATCH /api/projects returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000001",
      payload: { workspacePolicy: "git" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Project 不存在" },
    });
    expect(prisma.project.update).not.toHaveBeenCalled();
    await server.close();
  });
});
