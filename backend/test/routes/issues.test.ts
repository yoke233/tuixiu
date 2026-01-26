import { describe, expect, it, vi } from "vitest";

import { makeIssueRoutes } from "../../src/routes/issues.js";
import { createHttpServer } from "../test-utils.js";

describe("Issues routes", () => {
  it("GET /api/issues without status uses empty where", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([])
      }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({ method: "GET", url: "/api/issues?limit=1&offset=0" });
    expect(res.statusCode).toBe(200);
    expect(prisma.issue.count).toHaveBeenCalledWith({ where: {} });
    await server.close();
  });

  it("GET /api/issues returns list with total", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(12),
        findMany: vi.fn().mockResolvedValue([{ id: "i1" }])
      }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({ method: "GET", url: "/api/issues?limit=2&offset=1&status=pending" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { issues: [{ id: "i1" }], total: 12, limit: 2, offset: 1 }
    });
    await server.close();
  });

  it("GET /api/issues/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(null) }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({ method: "GET", url: "/api/issues/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } });
    await server.close();
  });

  it("GET /api/issues/:id returns issue when found", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue({ id: "i1" }) }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({ method: "GET", url: "/api/issues/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1" } } });
    await server.close();
  });

  it("POST /api/issues returns NO_PROJECT when there is no project", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue(null) }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NO_PROJECT", message: "请先创建 Project" } });
    await server.close();
  });

  it("POST /api/issues returns issue only when no available agents", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: { create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }) }
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeIssueRoutes({ prisma, sendToAgent }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1", acceptanceCriteria: ["a"], constraints: ["c"] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", title: "t1" } } });
    expect(sendToAgent).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/issues/:id/start schedules run and sends execute_task", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-r1"
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: "d1",
          status: "pending",
          acceptanceCriteria: ["a1"],
          constraints: ["c1"],
          testRequirements: null,
          runs: [],
          project: { id: "p1", defaultBranch: "main" }
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" })
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeIssueRoutes({ prisma, sendToAgent, createWorkspace }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r1");

    expect(sendToAgent).toHaveBeenCalledTimes(1);
    const [proxyId, payload] = sendToAgent.mock.calls[0];
    expect(proxyId).toBe("proxy-1");
    expect(payload.type).toBe("execute_task");
    expect(payload.run_id).toBe("r1");
    expect(payload.session_id).toBe("r1");
    expect(payload.prompt).toContain("任务标题: t1");
    expect(payload.prompt).toContain("- workspace:");
    expect(payload.prompt).toContain("run/r1");
    expect(payload.prompt).toContain("任务描述:");
    expect(payload.prompt).toContain("验收标准:");
    expect(payload.prompt).toContain("约束条件:");
    expect(payload.cwd).toBe("D:\\xyad\\tuixiu\\.worktrees\\run-r1");
    await server.close();
  });

  it("POST /api/issues/:id/start includes testRequirements when present", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-r1"
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          title: "t1",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: "需要加单测",
          runs: [],
          project: { id: "p1", defaultBranch: "main" }
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" })
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeIssueRoutes({ prisma, sendToAgent, createWorkspace }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" }
    });
    expect(res.statusCode).toBe(200);

    const [, payload] = sendToAgent.mock.calls[0];
    expect(payload.prompt).toContain("测试要求:");
    expect(payload.prompt).toContain("需要加单测");

    await server.close();
  });

  it("POST /api/issues/:id/start sends init when roleKey provided", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-r1"
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          title: "t1",
          description: "d1",
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          runs: [],
          project: { id: "p1", name: "Demo", repoUrl: "https://github.com/o/r", defaultBranch: "main", githubAccessToken: "ghp_xxx" }
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "role-1",
          key: "backend-dev",
          displayName: "后端开发",
          promptTemplate: "你是 {{role.name}}，请优先写单测。",
          initScript: "echo init",
          initTimeoutSeconds: 120
        })
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" })
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeIssueRoutes({ prisma, sendToAgent, createWorkspace }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010", roleKey: "backend-dev" }
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.roleTemplate.findFirst).toHaveBeenCalled();

    const [, payload] = sendToAgent.mock.calls[0];
    expect(payload.prompt).toContain("角色指令:");
    expect(payload.prompt).toContain("后端开发");
    expect(payload.init).toEqual(
      expect.objectContaining({
        script: "echo init",
        timeout_seconds: 120,
        env: expect.objectContaining({
          GH_TOKEN: "ghp_xxx",
          TUIXIU_ROLE_KEY: "backend-dev",
          TUIXIU_RUN_ID: "r1"
        })
      })
    );

    await server.close();
  });

  it("POST /api/issues/:id/start marks run failed when sendToAgent throws", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-r1"
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          title: "t1",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          runs: [],
          project: { id: "p1", defaultBranch: "main" }
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" })
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) }
    } as any;

    const sendToAgent = vi.fn().mockRejectedValue(new Error("boom"));
    await server.register(makeIssueRoutes({ prisma, sendToAgent, createWorkspace }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("AGENT_SEND_FAILED");
    expect(prisma.run.update).toHaveBeenCalled();
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    await server.close();
  });

  it("PATCH /api/issues/:id updates status when not running", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "pending" }),
        update: vi.fn().mockResolvedValue({ id: "i1", status: "done" })
      }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const id = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({
      method: "PATCH",
      url: `/api/issues/${id}`,
      payload: { status: "done" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", status: "done" } } });
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id }, data: { status: "done" } });

    await server.close();
  });

  it("PATCH /api/issues/:id returns ISSUE_RUNNING when issue is running", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "running" }),
        update: vi.fn()
      }
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/issues/00000000-0000-0000-0000-000000000001",
      payload: { status: "done" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "ISSUE_RUNNING", message: "Issue 正在运行中，请先完成/取消 Run" }
    });
    expect(prisma.issue.update).not.toHaveBeenCalled();

    await server.close();
  });
});
