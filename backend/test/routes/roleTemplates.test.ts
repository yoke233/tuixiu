import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeRoleTemplateRoutes } from "../../src/routes/roleTemplates.js";
import { createHttpServer } from "../test-utils.js";

describe("RoleTemplate routes", () => {
  it("GET /api/projects/:projectId/roles hides envText for non-admin", async () => {
    const server = createHttpServer();
    const prisma = {
      roleTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000001",
            projectId: "00000000-0000-0000-0000-000000000010",
            key: "dev",
            displayName: "Dev",
            envText: "B=2\nA=1\n",
          },
        ]),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({ method: "GET", url: "/api/projects/00000000-0000-0000-0000-000000000010/roles" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.roles).toHaveLength(1);
    expect(body.data.roles[0].envKeys).toEqual(["A", "B"]);
    expect(body.data.roles[0]).not.toHaveProperty("envText");

    await server.close();
  });

  it("GET /api/projects/:projectId/roles includes envText for admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000001",
            projectId: "00000000-0000-0000-0000-000000000010",
            key: "dev",
            displayName: "Dev",
            envText: "A=1\n",
          },
        ]),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.roles).toHaveLength(1);
    expect(body.data.roles[0].envKeys).toEqual(["A"]);
    expect(body.data.roles[0].envText).toBe("A=1\n");

    await server.close();
  });

  it("POST /api/projects/:projectId/roles returns NOT_FOUND when project missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue(null) },
      roleTemplate: { create: vi.fn() },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles",
      payload: { key: "dev", displayName: "Dev" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } });
    expect(prisma.roleTemplate.create).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/projects/:projectId/roles normalizes envText and returns envKeys", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000010" }) },
      roleTemplate: {
        create: vi.fn().mockImplementation(async ({ data }: any) => data),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "POST",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles",
      payload: { key: "dev", displayName: "Dev", envText: "  B=2\nA=1\n  " },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.role.envText).toBe("B=2\nA=1");
    expect(body.data.role.envKeys).toEqual(["A", "B"]);

    expect(prisma.roleTemplate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ projectId: "00000000-0000-0000-0000-000000000010", envText: "B=2\nA=1" }),
    });

    await server.close();
  });

  it("PATCH /api/projects/:projectId/roles/:roleId returns NOT_FOUND when role missing", async () => {
    const server = createHttpServer();
    const prisma = {
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000099",
      payload: { envText: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } });
    expect(prisma.roleTemplate.update).not.toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/projects/:projectId/roles/:roleId normalizes envText to null", async () => {
    const server = createHttpServer();
    const prisma = {
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000099",
          projectId: "00000000-0000-0000-0000-000000000010",
        }),
        update: vi.fn().mockImplementation(async ({ data }: any) => ({
          id: "00000000-0000-0000-0000-000000000099",
          projectId: "00000000-0000-0000-0000-000000000010",
          envText: data.envText,
        })),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000099",
      payload: { envText: "   " },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.success).toBe(true);
    expect(body.data.role.envText).toBeNull();
    expect(body.data.role.envKeys).toEqual([]);

    expect(prisma.roleTemplate.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000099" },
      data: expect.objectContaining({ envText: null }),
    });

    await server.close();
  });

  it("DELETE /api/projects/:projectId/roles/:roleId deletes role template", async () => {
    const server = createHttpServer();
    const prisma = {
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000099",
          projectId: "00000000-0000-0000-0000-000000000010",
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "DELETE",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000099",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { roleId: "00000000-0000-0000-0000-000000000099" } });
    expect(prisma.roleTemplate.delete).toHaveBeenCalledWith({ where: { id: "00000000-0000-0000-0000-000000000099" } });

    await server.close();
  });
});
