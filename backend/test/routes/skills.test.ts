import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeSkillRoutes } from "../../src/routes/skills.js";
import { createHttpServer } from "../test-utils.js";

describe("Skill routes", () => {
  it("GET /api/admin/skills/search returns FORBIDDEN for non-admin", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      skill: { findMany: vi.fn() },
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "pm" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/search",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
    expect(prisma.skill.findMany).not.toHaveBeenCalled();

    await server.close();
  });

  it("GET /api/admin/skills/search supports q/tags/limit and returns latestVersion", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const importedAt = new Date("2026-01-01T00:00:00.000Z");

    const prisma = {
      skill: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000001",
            name: "demo-skill",
            description: "desc",
            tags: ["tag1", "tag2"],
            latestVersion: { id: "v1", contentHash: "h1", importedAt },
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            name: "no-version-skill",
            description: null,
            tags: [],
            latestVersion: null,
          },
          {
            id: "00000000-0000-0000-0000-000000000003",
            name: "bad-version-skill",
            description: null,
            tags: [],
            latestVersion: { id: "v-bad", importedAt },
          },
        ]),
      },
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/search?provider=registry&q=Demo&tags=TAG1,%20tag2,tag1&limit=999",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 200,
        orderBy: { updatedAt: "desc" },
        where: {
          AND: [
            {
              OR: [
                { name: { contains: "Demo", mode: "insensitive" } },
                { description: { contains: "Demo", mode: "insensitive" } },
                { tags: { has: "demo" } },
              ],
            },
            { tags: { hasSome: ["tag1", "tag2"] } },
          ],
        },
        include: { latestVersion: { select: { id: true, contentHash: true, importedAt: true } } },
      }),
    );

    expect(res.json()).toEqual({
      success: true,
      data: {
        provider: "registry",
        items: [
          {
            skillId: "00000000-0000-0000-0000-000000000001",
            name: "demo-skill",
            description: "desc",
            tags: ["tag1", "tag2"],
            installed: true,
            latestVersion: { versionId: "v1", contentHash: "h1", importedAt: importedAt.toISOString() },
          },
          {
            skillId: "00000000-0000-0000-0000-000000000002",
            name: "no-version-skill",
            description: null,
            tags: [],
            installed: true,
            latestVersion: null,
          },
          {
            skillId: "00000000-0000-0000-0000-000000000003",
            name: "bad-version-skill",
            description: null,
            tags: [],
            installed: true,
            latestVersion: null,
          },
        ],
        nextCursor: null,
      },
    });

    await server.close();
  });

  it("GET /api/admin/skills/search(provider=skills.sh) returns empty when q is missing", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      skill: { findMany: vi.fn() },
    } as any;

    const fetchMock = vi.fn();
    const prevFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;
    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/search?provider=skills.sh",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { provider: "skills.sh", items: [], nextCursor: null },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.skill.findMany).not.toHaveBeenCalled();

    globalThis.fetch = prevFetch;
    await server.close();
  });

  it("GET /api/admin/skills/search(provider=skills.sh) uses skills.sh API and fills installed status", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const importedAt = new Date("2026-01-01T00:00:00.000Z");

    const prisma = {
      skill: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "00000000-0000-0000-0000-000000000010",
            name: "installed-skill",
            description: "desc",
            tags: ["t1"],
            sourceKey: "acme/repo@my-skill",
            latestVersion: { id: "v1", contentHash: "h1", importedAt, sourceRevision: null },
          },
        ]),
      },
    } as any;

    const fetchMock = vi.fn(async (url: string) => {
      if (!url.startsWith("https://skills.sh/api/search?")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          query: "skill",
          skills: [
            { id: "my-skill", name: "my-skill", installs: 1, topSource: "acme/repo" },
            { id: "other-skill", name: "other-skill", installs: 1, topSource: "acme/repo" },
          ],
          count: 2,
          duration_ms: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as any;

    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/search?provider=skills.sh&q=skill&limit=50",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://skills.sh/api/search?q=skill&limit=50",
      expect.objectContaining({ method: "GET" }),
    );
    expect(prisma.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceType: "skills.sh", sourceKey: { in: ["acme/repo@my-skill", "acme/repo@other-skill"] } },
      }),
    );

    expect(res.json()).toEqual({
      success: true,
      data: {
        provider: "skills.sh",
        items: [
          expect.objectContaining({
            skillId: "00000000-0000-0000-0000-000000000010",
            name: "installed-skill",
            installed: true,
            sourceType: "skills.sh",
            sourceKey: "acme/repo@my-skill",
            sourceRef: "https://skills.sh/acme/repo/my-skill",
            latestVersion: { versionId: "v1", contentHash: "h1", importedAt: importedAt.toISOString() },
          }),
          expect.objectContaining({
            skillId: "external:skills.sh:acme/repo@other-skill",
            name: "other-skill",
            installed: false,
            sourceType: "skills.sh",
            sourceKey: "acme/repo@other-skill",
            sourceRef: "https://skills.sh/acme/repo/other-skill",
            latestVersion: null,
          }),
        ],
        nextCursor: null,
      },
    });

    globalThis.fetch = prevFetch;
    await server.close();
  });

  it("GET /api/admin/skills/:skillId returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      skill: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/00000000-0000-0000-0000-000000000010",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Skill 不存在" } });

    await server.close();
  });

  it("GET /api/admin/skills/:skillId/versions returns versions", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const importedAt = new Date("2026-01-01T00:00:00.000Z");
    const prisma = {
      skill: { findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000020" }) },
      skillVersion: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "v1",
            skillId: "00000000-0000-0000-0000-000000000020",
            contentHash: "h1",
            storageUri: "s3://bucket/v1.zip",
            source: { repo: "example" },
            importedAt,
          },
        ]),
      },
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/api/admin/skills/00000000-0000-0000-0000-000000000020/versions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        skillId: "00000000-0000-0000-0000-000000000020",
        versions: [
          {
            id: "v1",
            contentHash: "h1",
            storageUri: "s3://bucket/v1.zip",
            source: { repo: "example" },
            sourceRevision: null,
            packageSize: null,
            manifestJson: null,
            importedAt: importedAt.toISOString(),
          },
        ],
      },
    });

    await server.close();
  });
});
