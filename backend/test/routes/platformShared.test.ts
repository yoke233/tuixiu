import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import {
  makePlatformGitCredentialRoutes,
} from "../../src/routes/gitCredentials.js";
import {
  makePlatformRoleTemplateRoutes,
  makeRoleTemplateRoutes,
} from "../../src/routes/roleTemplates.js";
import { createHttpServer } from "../test-utils.js";

describe("platform shared routes", () => {
  it("GET /api/admin/platform/git-credentials requires admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = { gitCredential: { findMany: vi.fn() } } as any;

    await server.register(makePlatformGitCredentialRoutes({ prisma, auth }), {
      prefix: "/api/admin/platform",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "pm" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/platform/git-credentials",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.gitCredential.findMany).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST/PATCH /api/admin/platform/git-credentials supports displayName", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      gitCredential: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: "00000000-0000-0000-0000-000000000100",
            projectId: null,
            scope: "platform",
            key: "github-member",
            displayName: "GitHub 成员凭证",
          }),
        create: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000100",
          projectId: null,
          scope: "platform",
          key: "github-member",
          displayName: "GitHub 成员凭证",
          purpose: "run",
          gitAuthMode: "https_pat",
          githubAccessToken: "ghp_xxx",
          gitlabAccessToken: null,
          gitHttpUsername: null,
          gitHttpPassword: null,
          gitSshKey: null,
          gitSshKeyB64: null,
          updatedAt: new Date("2026-02-27T00:00:00.000Z"),
        }),
        update: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000100",
          projectId: null,
          scope: "platform",
          key: "github-member",
          displayName: "GitHub 管理员凭证",
          purpose: "run",
          gitAuthMode: "https_pat",
          githubAccessToken: "ghp_xxx",
          gitlabAccessToken: null,
          gitHttpUsername: null,
          gitHttpPassword: null,
          gitSshKey: null,
          gitSshKeyB64: null,
          updatedAt: new Date("2026-02-27T01:00:00.000Z"),
        }),
      },
    } as any;

    await server.register(makePlatformGitCredentialRoutes({ prisma, auth }), {
      prefix: "/api/admin/platform",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const createRes = await server.inject({
      method: "POST",
      url: "/api/admin/platform/git-credentials",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        key: "github-member",
        displayName: "GitHub 成员凭证",
        purpose: "run",
        githubAccessToken: "ghp_xxx",
      },
    });
    expect(createRes.statusCode).toBe(200);
    expect(createRes.json()).toEqual({
      success: true,
      data: {
        credential: expect.objectContaining({
          id: "00000000-0000-0000-0000-000000000100",
          key: "github-member",
          displayName: "GitHub 成员凭证",
          scope: "platform",
        }),
      },
    });
    expect(prisma.gitCredential.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "github-member",
        displayName: "GitHub 成员凭证",
        scope: "platform",
      }),
    });

    const patchRes = await server.inject({
      method: "PATCH",
      url: "/api/admin/platform/git-credentials/00000000-0000-0000-0000-000000000100",
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "GitHub 管理员凭证" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({
      success: true,
      data: {
        credential: expect.objectContaining({
          id: "00000000-0000-0000-0000-000000000100",
          key: "github-member",
          displayName: "GitHub 管理员凭证",
        }),
      },
    });
    expect(prisma.gitCredential.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000100" },
      data: { displayName: "GitHub 管理员凭证" },
    });

    await server.close();
  });

  it("GET /api/projects/:projectId/roles?includePlatform=1 returns project + platform roles", async () => {
    const server = createHttpServer();
    const prisma = {
      roleTemplate: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              id: "r1",
              projectId: "00000000-0000-0000-0000-000000000010",
              scope: "project",
              key: "dev",
              displayName: "Dev",
              envText: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: "r2",
              projectId: null,
              scope: "platform",
              key: "reviewer",
              displayName: "Reviewer",
              envText: null,
            },
          ]),
      },
    } as any;

    await server.register(makeRoleTemplateRoutes({ prisma }), { prefix: "/api/projects" });

    const res = await server.inject({
      method: "GET",
      url: "/api/projects/00000000-0000-0000-0000-000000000010/roles?includePlatform=1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        roles: [
          expect.objectContaining({ id: "r1", key: "dev", scope: "project" }),
          expect.objectContaining({ id: "r2", key: "reviewer", scope: "platform" }),
        ],
      },
    });

    await server.close();
  });

  it("GET /api/admin/platform/roles requires admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = { roleTemplate: { findMany: vi.fn() } } as any;

    await server.register(makePlatformRoleTemplateRoutes({ prisma, auth }), {
      prefix: "/api/admin/platform",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "dev" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/platform/roles",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.roleTemplate.findMany).not.toHaveBeenCalled();
    await server.close();
  });

  it("DELETE /api/admin/platform/roles/:roleId allows delete when project role overrides same key", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000301",
          projectId: null,
          scope: "platform",
          key: "reviewer",
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      project: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any;

    await server.register(makePlatformRoleTemplateRoutes({ prisma, auth }), {
      prefix: "/api/admin/platform",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/platform/roles/00000000-0000-0000-0000-000000000301",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { roleId: "00000000-0000-0000-0000-000000000301" },
    });
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: {
        defaultRoleKey: "reviewer",
        NOT: {
          roles: {
            some: { key: "reviewer", scope: "project" },
          },
        },
      },
      select: { id: true },
    });
    expect(prisma.roleTemplate.delete).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000301" },
    });

    await server.close();
  });

  it("DELETE /api/admin/platform/roles/:roleId blocks delete when project defaultRoleKey depends on platform role", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000302",
          projectId: null,
          scope: "platform",
          key: "reviewer",
        }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      project: {
        findFirst: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000010" }),
      },
    } as any;

    await server.register(makePlatformRoleTemplateRoutes({ prisma, auth }), {
      prefix: "/api/admin/platform",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "DELETE",
      url: "/api/admin/platform/roles/00000000-0000-0000-0000-000000000302",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_INPUT", message: "该平台公共 Role 已被项目默认角色引用，无法删除" },
    });
    expect(prisma.roleTemplate.delete).not.toHaveBeenCalled();

    await server.close();
  });
});
