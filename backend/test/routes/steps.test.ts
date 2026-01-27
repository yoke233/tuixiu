import { describe, expect, it, vi } from "vitest";

import { makeStepRoutes } from "../../src/routes/steps.js";
import { createHttpServer } from "../test-utils.js";

describe("Steps routes", () => {
  it("POST /api/steps/:id/start returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      step: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;
    await server.register(makeStepRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/steps/00000000-0000-0000-0000-000000000001/start",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Step 不存在" } });
    await server.close();
  });

  it("POST /api/steps/:id/start returns NOT_READY when not ready", async () => {
    const server = createHttpServer();
    const prisma = {
      step: { findUnique: vi.fn().mockResolvedValue({ id: "s1", status: "pending", task: { id: "t1" } }) },
    } as any;
    await server.register(makeStepRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/steps/00000000-0000-0000-0000-000000000001/start",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_READY", message: "Step 不是 ready 状态，无法启动" } });
    await server.close();
  });

  it("POST /api/steps/:id/start starts step and creates run", async () => {
    const server = createHttpServer();
    const prisma = {
      step: {
        findUnique: vi.fn().mockResolvedValue({
          id: "s1",
          key: "prd.generate",
          kind: "prd.generate",
          order: 1,
          status: "ready",
          executorType: "agent",
          roleKey: null,
          params: null,
          task: { id: "t1", issueId: "i1", workspacePath: null, workspaceType: null, branchName: null },
        }),
        update: vi.fn().mockResolvedValue({ id: "s1", status: "running" }),
        updateMany: vi.fn(),
      },
      run: {
        findFirst: vi.fn().mockResolvedValue({ attempt: 2 }),
        create: vi.fn().mockResolvedValue({ id: "r1", status: "running" }),
      },
      task: {
        update: vi.fn().mockResolvedValue({ id: "t1", status: "running", currentStepId: "s1", issueId: "i1" }),
        findUnique: vi.fn(),
      },
      issue: { update: vi.fn().mockResolvedValue({ id: "i1" }) },
    } as any;

    await server.register(makeStepRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/steps/00000000-0000-0000-0000-000000000001/start",
      payload: { executorType: "agent" },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.success).toBe(true);
    expect(json.data.run.id).toBe("r1");

    expect(prisma.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: "t1", stepId: "s1", executorType: "agent", attempt: 3 }),
      }),
    );
    await server.close();
  });

  it("POST /api/tasks/:id/rollback returns NOT_FOUND when task missing", async () => {
    const server = createHttpServer();
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      step: {
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      issue: { update: vi.fn() },
    } as any;

    await server.register(makeStepRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/tasks/00000000-0000-0000-0000-000000000001/rollback",
      payload: { stepId: "00000000-0000-0000-0000-000000000002" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Task 不存在" } });
    await server.close();
  });

  it("POST /api/tasks/:id/rollback resets later steps", async () => {
    const server = createHttpServer();
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          steps: [
            { id: "00000000-0000-0000-0000-000000000010", order: 1, status: "completed" },
            { id: "00000000-0000-0000-0000-000000000020", order: 2, status: "failed" },
            { id: "00000000-0000-0000-0000-000000000030", order: 3, status: "pending" },
          ],
        }),
        update: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          status: "running",
          currentStepId: "00000000-0000-0000-0000-000000000020",
          steps: [],
        }),
      },
      step: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000020", status: "ready" }),
      },
      issue: { update: vi.fn().mockResolvedValue({ id: "i1" }) },
    } as any;

    await server.register(makeStepRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/tasks/00000000-0000-0000-0000-000000000001/rollback",
      payload: { stepId: "00000000-0000-0000-0000-000000000020" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(prisma.step.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ taskId: "t1" }),
      }),
    );
    expect(prisma.step.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "00000000-0000-0000-0000-000000000020" } }),
    );
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" } }));
    await server.close();
  });
});
