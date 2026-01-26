import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createHttpServer } from "../test-utils.js";

describe("Runs routes", () => {
  it("GET /api/runs/:id returns run", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1" }) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { run: { id: "r1" } } });
    await server.close();
  });

  it("GET /api/runs/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(null) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Run 不存在" }
    });
    await server.close();
  });

  it("GET /api/runs/:id/events returns events", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { findMany: vi.fn().mockResolvedValue([{ id: "e1" }]) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/events?limit=3"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { events: [{ id: "e1" }] } });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "00000000-0000-0000-0000-000000000001" },
      orderBy: { timestamp: "desc" },
      take: 3
    });
    await server.close();
  });

  it("POST /api/runs/:id/cancel marks cancelled", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { update: vi.fn().mockResolvedValue({ id: "r2", status: "cancelled", issueId: "i2", agentId: "a2" }) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000002/cancel"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r2");
    expect(prisma.run.update).toHaveBeenCalled();
    const call = prisma.run.update.mock.calls[0][0];
    expect(call.where.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(call.data.status).toBe("cancelled");
    expect(call.data.completedAt).toBeInstanceOf(Date);
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/complete marks completed", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { update: vi.fn().mockResolvedValue({ id: "r2", status: "completed", issueId: "i2", agentId: "a2" }) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000002/complete"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r2");
    expect(prisma.run.update).toHaveBeenCalled();
    const call = prisma.run.update.mock.calls[0][0];
    expect(call.where.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(call.data.status).toBe("completed");
    expect(call.data.completedAt).toBeInstanceOf(Date);
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/prompt persists user message and forwards to agent", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          agent: { proxyId: "proxy-1" },
          issue: { title: "t1" },
          artifacts: []
        })
      },
      event: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeRunRoutes({ prisma, sendToAgent }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/prompt",
      payload: { text: "hello" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });

    expect(prisma.event.create).toHaveBeenCalled();
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "prompt_run",
        run_id: "00000000-0000-0000-0000-000000000001",
        prompt: "hello"
      })
    );
    await server.close();
  });

  it("POST /api/runs/:id/create-mr pushes branch and creates MR artifact", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "completed",
          branchName: "run/r1",
          workspacePath: "D:\\repo\\.worktrees\\run-r1",
          issue: {
            id: "i1",
            title: "t1",
            description: "d1",
            project: {
              repoUrl: "https://gitlab.example.com/group/repo.git",
              scmType: "gitlab",
              defaultBranch: "main",
              gitlabProjectId: 123,
              gitlabAccessToken: "tok"
            }
          },
          artifacts: []
        }),
        update: vi.fn().mockResolvedValue({})
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "mr-1", type: "mr" }) }
    } as any;

    const gitPush = vi.fn().mockResolvedValue(undefined);
    const createMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "opened",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main"
    });

    await server.register(
      makeRunRoutes({
        prisma,
        gitPush,
        gitlab: {
          inferBaseUrl: () => "https://gitlab.example.com",
          createMergeRequest,
          mergeMergeRequest: vi.fn(),
          getMergeRequest: vi.fn()
        }
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/create-mr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(gitPush).toHaveBeenCalledWith({ cwd: "D:\\repo\\.worktrees\\run-r1", branch: "run/r1" });
    expect(createMergeRequest).toHaveBeenCalled();
    expect(prisma.artifact.create).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: { status: "waiting_ci" } })
    );
    await server.close();
  });

  it("POST /api/runs/:id/merge-mr merges MR and marks issue done", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: {
            id: "i1",
            project: {
              repoUrl: "https://gitlab.example.com/group/repo.git",
              scmType: "gitlab",
              gitlabProjectId: 123,
              gitlabAccessToken: "tok"
            }
          },
          artifacts: [{ id: "mr-1", type: "mr", content: { iid: 7 } }]
        }),
        update: vi.fn().mockResolvedValue({})
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
      artifact: { update: vi.fn().mockResolvedValue({ id: "mr-1", type: "mr", content: { iid: 7, state: "merged" } }) }
    } as any;

    const mergeMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "merged",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main"
    });
    const getMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "merged",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main"
    });

    await server.register(
      makeRunRoutes({
        prisma,
        gitlab: {
          inferBaseUrl: () => "https://gitlab.example.com",
          createMergeRequest: vi.fn(),
          mergeMergeRequest,
          getMergeRequest
        }
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/merge-mr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mergeMergeRequest).toHaveBeenCalled();
    expect(getMergeRequest).toHaveBeenCalled();
    expect(prisma.artifact.update).toHaveBeenCalled();
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "done" } });
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "completed" } });
    await server.close();
  });
});
