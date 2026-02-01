import { describe, expect, it, vi } from "vitest";

import { makeExecutionProfileRoutes } from "../../src/routes/executionProfiles.js";
import { createHttpServer } from "../test-utils.js";

describe("ExecutionProfile routes", () => {
  it("GET /api/execution-profiles returns list", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: { findMany: vi.fn().mockResolvedValue([{ id: "p1" }]) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({ method: "GET", url: "/api/execution-profiles" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { profiles: [{ id: "p1" }] } });

    await server.close();
  });

  it("GET /api/execution-profiles returns empty list", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({ method: "GET", url: "/api/execution-profiles" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { profiles: [] } });

    await server.close();
  });

  it("GET /api/execution-profiles/:id returns NOT_FOUND", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" },
    });

    await server.close();
  });

  it("POST /api/execution-profiles creates and audits", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: { create: vi.fn().mockResolvedValue({ id: "p2", key: "k1" }) },
      executionProfileAuditLog: { create: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/execution-profiles",
      payload: { key: "k1", workspacePolicy: "empty" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.executionProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: "k1", workspacePolicy: "empty" }),
    });
    expect(prisma.executionProfileAuditLog.create).toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/execution-profiles returns 400 on invalid body", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: { create: vi.fn() },
      executionProfileAuditLog: { create: vi.fn() },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/execution-profiles",
      payload: { workspacePolicy: "empty" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "BAD_REQUEST" }),
      }),
    );
    expect(prisma.executionProfile.create).not.toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/execution-profiles/:id updates and audits", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000002", key: "k1" }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000002" }),
      },
      executionProfileAuditLog: { create: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
      payload: { workspacePolicy: "mount" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.executionProfile.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000002" },
      data: expect.objectContaining({ workspacePolicy: "mount" }),
    });
    expect(prisma.executionProfileAuditLog.create).toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/execution-profiles/:id allows nullable fields", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000002", key: "k1" }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000002" }),
      },
      executionProfileAuditLog: { create: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
      payload: { displayName: null, workspacePolicy: null },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.executionProfile.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000002" },
      data: expect.objectContaining({ displayName: null, workspacePolicy: null }),
    });

    await server.close();
  });

  it("PATCH /api/execution-profiles/:id returns NOT_FOUND", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
      payload: { displayName: "x" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" },
    });

    await server.close();
  });

  it("DELETE /api/execution-profiles/:id deletes and audits", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000002", key: "k1" }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      executionProfileAuditLog: { create: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "DELETE",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.executionProfile.delete).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000002" },
    });
    expect(prisma.executionProfileAuditLog.create).toHaveBeenCalled();

    await server.close();
  });

  it("DELETE /api/execution-profiles/:id returns NOT_FOUND", async () => {
    const server = createHttpServer();
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
      },
    } as any;

    await server.register(makeExecutionProfileRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "DELETE",
      url: "/api/execution-profiles/00000000-0000-0000-0000-000000000002",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "ExecutionProfile 不存在" },
    });

    await server.close();
  });
});
