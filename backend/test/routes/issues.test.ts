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
      issue: { create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }) },
      agent: { findMany: vi.fn().mockResolvedValue([]) }
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

  it("POST /api/issues schedules run and sends execute_task", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: {
        create: vi.fn().mockResolvedValue({ id: "i1", title: "t1", description: "d1" }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", proxyId: "proxy-1", status: "online", currentLoad: 0, maxConcurrentRuns: 1 }
        ]),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: { create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeIssueRoutes({ prisma, sendToAgent }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1", description: "d1", acceptanceCriteria: ["a1"], constraints: ["c1"] }
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
    expect(payload.prompt).toContain("任务描述:");
    expect(payload.prompt).toContain("验收标准:");
    expect(payload.prompt).toContain("约束条件:");
    await server.close();
  });

  it("POST /api/issues uses projectId and includes testRequirements", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: {
        create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", proxyId: "proxy-1", status: "online", currentLoad: 0, maxConcurrentRuns: 1 }
        ]),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: { create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }) }
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    await server.register(makeIssueRoutes({ prisma, sendToAgent }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: {
        projectId: "00000000-0000-0000-0000-000000000003",
        title: "t1",
        testRequirements: "需要加单测"
      }
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000003" }
    });

    const [, payload] = sendToAgent.mock.calls[0];
    expect(payload.prompt).toContain("测试要求:");
    expect(payload.prompt).toContain("需要加单测");

    await server.close();
  });

  it("POST /api/issues marks run failed when sendToAgent throws", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: {
        create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }),
        update: vi.fn().mockResolvedValue({ id: "i1" })
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", proxyId: "proxy-1", status: "online", currentLoad: 0, maxConcurrentRuns: 1 }
        ]),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" })
      }
    } as any;

    const sendToAgent = vi.fn().mockRejectedValue(new Error("boom"));
    await server.register(makeIssueRoutes({ prisma, sendToAgent }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1" }
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
});
