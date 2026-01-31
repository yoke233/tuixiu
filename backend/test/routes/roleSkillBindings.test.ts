import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeRoleSkillBindingRoutes } from "../../src/routes/roleSkillBindings.js";
import { createHttpServer } from "../test-utils.js";

describe("RoleSkillBinding routes", () => {
  it("GET /api/admin/projects/:projectId/roles/:roleId/skills returns NOT_FOUND when role missing", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
      roleSkillBinding: { findMany: vi.fn() },
    } as any;

    await server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000011/skills",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "RoleTemplate 不存在" } });
    expect(prisma.roleSkillBinding.findMany).not.toHaveBeenCalled();

    await server.close();
  });

  it("PUT /api/admin/projects/:projectId/roles/:roleId/skills returns BAD_INPUT for duplicate skillId", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1" }) },
      skill: { findMany: vi.fn() },
      skillVersion: { findMany: vi.fn() },
      roleSkillBinding: { findMany: vi.fn() },
      $transaction: vi.fn(),
    } as any;

    await server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/admin/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000011/skills",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [
          { skillId: "00000000-0000-0000-0000-000000000001" },
          { skillId: "00000000-0000-0000-0000-000000000001" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_INPUT", message: "重复的 skillId: 00000000-0000-0000-0000-000000000001" },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await server.close();
  });

  it("PUT /api/admin/projects/:projectId/roles/:roleId/skills requires pinnedVersionId when pinned", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1" }) },
      skill: { findMany: vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]) },
      skillVersion: { findMany: vi.fn() },
      roleSkillBinding: { findMany: vi.fn() },
      $transaction: vi.fn(),
    } as any;

    await server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/admin/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000011/skills",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [{ skillId: "00000000-0000-0000-0000-000000000001", versionPolicy: "PINNED" }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_INPUT", message: "versionPolicy=pinned 时必须提供 pinnedVersionId" },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await server.close();
  });

  it("PUT /api/admin/projects/:projectId/roles/:roleId/skills validates pinnedVersionId belongs to skill", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const pinnedVersionId = "00000000-0000-0000-0000-000000000101";
    const prisma = {
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1" }) },
      skill: { findMany: vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]) },
      skillVersion: {
        findMany: vi.fn().mockResolvedValue([
          { id: pinnedVersionId, skillId: "00000000-0000-0000-0000-000000000002" },
        ]),
      },
      roleSkillBinding: { findMany: vi.fn() },
      $transaction: vi.fn(),
    } as any;

    await server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/admin/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000011/skills",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [
          {
            skillId: "00000000-0000-0000-0000-000000000001",
            versionPolicy: "pinned",
            pinnedVersionId,
            enabled: true,
          },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: {
        code: "BAD_INPUT",
        message:
          `pinnedVersionId 不属于该 skill（skillId=00000000-0000-0000-0000-000000000001, pinnedVersionId=${pinnedVersionId}）`,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await server.close();
  });

  it("PUT /api/admin/projects/:projectId/roles/:roleId/skills replaces bindings atomically", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const pinnedVersionId = "00000000-0000-0000-0000-000000000102";

    const tx = {
      roleSkillBinding: {
        deleteMany: vi.fn().mockResolvedValue(undefined),
        createMany: vi.fn().mockResolvedValue(undefined),
      },
    };

    const prisma = {
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1" }) },
      skill: {
        findMany: vi.fn().mockResolvedValue([
          { id: "00000000-0000-0000-0000-000000000001", latestVersionId: "00000000-0000-0000-0000-000000000201" },
          { id: "00000000-0000-0000-0000-000000000002", latestVersionId: null },
        ]),
      },
      skillVersion: {
        findMany: vi.fn().mockResolvedValue([
          { id: pinnedVersionId, skillId: "00000000-0000-0000-0000-000000000002" },
        ]),
      },
      roleSkillBinding: {
        findMany: vi.fn().mockResolvedValue([
          {
            skillId: "00000000-0000-0000-0000-000000000001",
            versionPolicy: "latest",
            pinnedVersionId: null,
            enabled: true,
            skill: { id: "00000000-0000-0000-0000-000000000001", name: "skill-1" },
          },
          {
            skillId: "00000000-0000-0000-0000-000000000002",
            versionPolicy: "pinned",
            pinnedVersionId,
            enabled: true,
            skill: { id: "00000000-0000-0000-0000-000000000002", name: "skill-2" },
          },
        ]),
      },
      $transaction: vi.fn().mockImplementation(async (fn: any) => {
        await fn(tx);
      }),
    } as any;

    await server.register(makeRoleSkillBindingRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "PUT",
      url: "/api/admin/projects/00000000-0000-0000-0000-000000000010/roles/00000000-0000-0000-0000-000000000011/skills",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [
          { skillId: "00000000-0000-0000-0000-000000000001", versionPolicy: "latest", enabled: true },
          { skillId: "00000000-0000-0000-0000-000000000002", versionPolicy: "PINNED", pinnedVersionId },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.roleSkillBinding.deleteMany).toHaveBeenCalledWith({ where: { roleTemplateId: "00000000-0000-0000-0000-000000000011" } });
    expect(tx.roleSkillBinding.createMany).toHaveBeenCalledWith({
      data: [
        {
          roleTemplateId: "00000000-0000-0000-0000-000000000011",
          skillId: "00000000-0000-0000-0000-000000000001",
          versionPolicy: "latest",
          pinnedVersionId: null,
          enabled: true,
        },
        {
          roleTemplateId: "00000000-0000-0000-0000-000000000011",
          skillId: "00000000-0000-0000-0000-000000000002",
          versionPolicy: "pinned",
          pinnedVersionId,
          enabled: true,
        },
      ],
    });

    expect(res.json()).toEqual({
      success: true,
      data: {
        projectId: "00000000-0000-0000-0000-000000000010",
        roleId: "00000000-0000-0000-0000-000000000011",
        items: [
          {
            skillId: "00000000-0000-0000-0000-000000000001",
            name: "skill-1",
            versionPolicy: "latest",
            pinnedVersionId: null,
            enabled: true,
          },
          {
            skillId: "00000000-0000-0000-0000-000000000002",
            name: "skill-2",
            versionPolicy: "pinned",
            pinnedVersionId,
            enabled: true,
          },
        ],
      },
    });

    await server.close();
  });
});
