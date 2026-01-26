import { describe, expect, it, vi } from "vitest";

import { makeProjectRoutes } from "../../src/routes/projects.js";
import { createHttpServer } from "../test-utils.js";

describe("Projects routes", () => {
  it("GET /api/projects returns list", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) }
    } as any;

    await server.register(makeProjectRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({ method: "GET", url: "/api/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { projects: [{ id: "p1" }] } });
    expect(prisma.project.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
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
    expect(res.json()).toEqual({ success: true, data: { project: { id: "p2" } } });

    expect(prisma.project.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        name: "Demo",
        repoUrl: "https://example.com/repo.git",
        scmType: "gitlab",
        defaultBranch: "main",
        defaultRoleKey: undefined,
        gitlabProjectId: undefined,
        gitlabAccessToken: undefined,
        gitlabWebhookSecret: undefined,
        githubAccessToken: undefined
      }
    });
    await server.close();
  });
});
