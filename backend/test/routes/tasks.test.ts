import { describe, expect, it, vi } from "vitest";

import { makeTaskRoutes } from "../../src/routes/tasks.js";
import { createHttpServer } from "../test-utils.js";

describe("Tasks routes", () => {
  it("GET /api/task-templates returns templates", async () => {
    const server = createHttpServer();
    await server.register(makeTaskRoutes({ prisma: {} as any }), { prefix: "/api" });

    const res = await server.inject({ method: "GET", url: "/api/task-templates" });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.templates)).toBe(true);
    expect(json.data.templates.length).toBeGreaterThan(0);
    await server.close();
  });

  it("POST /api/issues/:id/tasks returns BAD_TEMPLATE for unknown template", async () => {
    const server = createHttpServer();
    const prisma = { issue: { findUnique: vi.fn().mockResolvedValue({ id: "i1", project: { defaultBranch: "main" } }) } } as any;
    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/tasks",
      payload: { templateKey: "nope" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_TEMPLATE", message: "未知的模板", details: "nope" },
    });
    expect(prisma.issue.findUnique).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/issues/:id/tasks returns NOT_FOUND when issue missing", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/tasks",
      payload: { templateKey: "planning.prd.only" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } });
    await server.close();
  });

  it("POST /api/issues/:id/tasks creates task with steps", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue({ id: "i1", project: { defaultBranch: "main" } }) },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t1" }),
        update: vi.fn().mockImplementation(async (args: any) => ({
          id: "t1",
          issueId: "i1",
          templateKey: "planning.prd.only",
          currentStepId: args?.data?.currentStepId ?? null,
          status: "pending",
          steps: [
            { id: "s1", key: "prd.generate", order: 1, status: "ready" },
            { id: "s2", key: "prd.review", order: 2, status: "pending" },
          ],
        })),
      },
    } as any;

    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/tasks",
      payload: { templateKey: "planning.prd.only" },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.task.id).toBe("t1");
    expect(json.data.task.templateKey).toBe("planning.prd.only");

    const createCall = prisma.task.create.mock.calls[0]?.[0] as any;
    expect(createCall.data.issueId).toBe("00000000-0000-0000-0000-000000000001");
    expect(createCall.data.templateKey).toBe("planning.prd.only");
    expect(createCall.data.steps.create.length).toBeGreaterThan(0);
    expect(createCall.data.steps.create[0]).toEqual(
      expect.objectContaining({ key: "prd.generate", kind: "prd.generate", order: 1, status: "ready" }),
    );

    const updateCall = prisma.task.update.mock.calls[0]?.[0] as any;
    expect(updateCall.where.id).toBeDefined();
    expect(updateCall.data.currentStepId).toBeDefined();
    await server.close();
  });

  it("POST /api/issues/:id/tasks supports project-level template overrides", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          project: {
            defaultBranch: "main",
            branchProtection: {
              taskTemplates: {
                "custom.hello": {
                  displayName: "Hello",
                  steps: [{ key: "dev.implement", kind: "dev.implement", executorType: "agent" }],
                },
              },
            },
          },
        }),
      },
      task: {
        create: vi.fn().mockResolvedValue({ id: "t1" }),
        update: vi.fn().mockImplementation(async (args: any) => ({
          id: "t1",
          issueId: "i1",
          templateKey: "custom.hello",
          currentStepId: args?.data?.currentStepId ?? null,
          status: "pending",
          steps: [{ id: "s1", key: "dev.implement", order: 1, status: "ready" }],
        })),
      },
    } as any;

    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/tasks",
      payload: { templateKey: "custom.hello" },
    });
    expect(res.statusCode).toBe(200);

    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.task.templateKey).toBe("custom.hello");

    const createCall = prisma.task.create.mock.calls[0]?.[0] as any;
    expect(createCall.data.templateKey).toBe("custom.hello");
    expect(createCall.data.steps.create[0]).toEqual(
      expect.objectContaining({ key: "dev.implement", kind: "dev.implement", order: 1, status: "ready" }),
    );

    await server.close();
  });

  it("GET /api/issues/:id/tasks lists tasks", async () => {
    const server = createHttpServer();
    const prisma = {
      task: { findMany: vi.fn().mockResolvedValue([{ id: "t1" }]) },
    } as any;
    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/tasks",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { tasks: [{ id: "t1" }] } });
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { issueId: "00000000-0000-0000-0000-000000000001" } }),
    );
    await server.close();
  });

  it("GET /api/tasks/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      task: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/tasks/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Task 不存在" } });
    await server.close();
  });

  it("GET /api/tasks/:id returns task when found", async () => {
    const server = createHttpServer();
    const prisma = {
      task: { findUnique: vi.fn().mockResolvedValue({ id: "t1", steps: [], runs: [], issue: { id: "i1", project: {} } }) },
    } as any;
    await server.register(makeTaskRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/tasks/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { task: { id: "t1", steps: [], runs: [], issue: { id: "i1", project: {} } } } });
    await server.close();
  });
});
