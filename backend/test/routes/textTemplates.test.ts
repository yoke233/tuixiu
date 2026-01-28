import { describe, expect, it, vi } from "vitest";

import { makeTextTemplateRoutes } from "../../src/routes/textTemplates.js";
import { createHttpServer } from "../test-utils.js";

describe("textTemplates admin routes", () => {
  it("GET /api/admin/text-templates returns platform templates", async () => {
    const server = createHttpServer();
    const prisma = {
      platformTextTemplate: {
        findMany: vi.fn().mockResolvedValue([{ key: "k1", template: " t1 " }]),
      },
    } as any;
    const auth = { requireRoles: vi.fn().mockReturnValue(async () => {}) } as any;

    await server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({ method: "GET", url: "/api/admin/text-templates" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { templates: { k1: "t1" } } });

    await server.close();
  });

  it("PATCH /api/admin/text-templates patches platform templates", async () => {
    const server = createHttpServer();
    const prisma = {
      platformTextTemplate: {
        findMany: vi.fn().mockResolvedValue([{ key: "k2", template: "t2" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as any;
    const auth = { requireRoles: vi.fn().mockReturnValue(async () => {}) } as any;

    await server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/text-templates",
      payload: { templates: { k1: null, k2: "t2" } },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.platformTextTemplate.deleteMany).toHaveBeenCalledWith({ where: { key: "k1" } });
    expect(prisma.platformTextTemplate.upsert).toHaveBeenCalledWith({
      where: { key: "k2" },
      create: { key: "k2", template: "t2" },
      update: { template: "t2" },
    });
    expect(res.json()).toEqual({ success: true, data: { templates: { k2: "t2" } } });

    await server.close();
  });

  it("PATCH /api/admin/text-templates rejects invalid templates", async () => {
    const server = createHttpServer();
    const prisma = {
      platformTextTemplate: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as any;
    const auth = { requireRoles: vi.fn().mockReturnValue(async () => {}) } as any;

    await server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/admin/text-templates",
      payload: { templates: { bad: "{{#if x}}" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: expect.objectContaining({ code: "BAD_TEMPLATE", message: "模板编译失败: bad" }),
    });
    expect(prisma.platformTextTemplate.upsert).not.toHaveBeenCalled();

    await server.close();
  });

  it("GET /api/admin/projects/:projectId/text-templates returns platform/overrides/effective", async () => {
    const server = createHttpServer();
    const projectId = "00000000-0000-0000-0000-000000000001";
    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: projectId }) },
      platformTextTemplate: { findMany: vi.fn().mockResolvedValue([{ key: "k1", template: "p" }]) },
      projectTextTemplate: { findMany: vi.fn().mockResolvedValue([{ key: "k1", template: "o" }, { key: "k2", template: "o2" }]) },
    } as any;
    const auth = { requireRoles: vi.fn().mockReturnValue(async () => {}) } as any;

    await server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({ method: "GET", url: `/api/admin/projects/${projectId}/text-templates` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        projectId,
        platform: { k1: "p" },
        overrides: { k1: "o", k2: "o2" },
        effective: { k1: "o", k2: "o2" },
      },
    });

    await server.close();
  });

  it("PATCH /api/admin/projects/:projectId/text-templates patches overrides", async () => {
    const server = createHttpServer();
    const projectId = "00000000-0000-0000-0000-000000000002";
    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: projectId }) },
      platformTextTemplate: { findMany: vi.fn().mockResolvedValue([{ key: "k1", template: "p" }]) },
      projectTextTemplate: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([{ key: "k2", template: "o2" }]),
      },
    } as any;
    const auth = { requireRoles: vi.fn().mockReturnValue(async () => {}) } as any;

    await server.register(makeTextTemplateRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "PATCH",
      url: `/api/admin/projects/${projectId}/text-templates`,
      payload: { templates: { k1: null, k2: " o2 " } },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.projectTextTemplate.deleteMany).toHaveBeenCalledWith({ where: { projectId, key: "k1" } });
    expect(prisma.projectTextTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_key: { projectId, key: "k2" } },
        update: { template: "o2" },
      }),
    );
    expect(res.json()).toEqual({
      success: true,
      data: {
        projectId,
        platform: { k1: "p" },
        overrides: { k2: "o2" },
        effective: { k1: "p", k2: "o2" },
      },
    });

    await server.close();
  });
});
