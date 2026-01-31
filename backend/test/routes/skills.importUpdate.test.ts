import { describe, expect, it, vi, beforeEach } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { createHttpServer } from "../test-utils.js";

const { prepareSkillsShImportMock, packageSkillsShPreparedMock } = vi.hoisted(() => ({
  prepareSkillsShImportMock: vi.fn(),
  packageSkillsShPreparedMock: vi.fn(),
}));

vi.mock("../../src/modules/skills/skillsShImport.js", () => ({
  prepareSkillsShImport: prepareSkillsShImportMock,
  packageSkillsShPrepared: packageSkillsShPreparedMock,
}));

const { makeSkillRoutes } = await import("../../src/routes/skills.js");

describe("Skill routes import/update", () => {
  beforeEach(() => {
    prepareSkillsShImportMock.mockReset();
    packageSkillsShPreparedMock.mockReset();
  });

  it("POST /api/admin/skills/import is idempotent by contentHash and writes audit logs", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const contentHash = "a".repeat(64);
    prepareSkillsShImportMock.mockResolvedValue({
      prepared: {
        source: {
          sourceType: "skills.sh",
          sourceKey: "acme/repo@my-skill",
          sourceRef: "https://skills.sh/acme/repo/my-skill",
          owner: "acme",
          repo: "repo",
          skill: "my-skill",
          githubRepoUrl: "https://github.com/acme/repo",
          skillDir: "skills/my-skill",
        },
        skillDir: "C:\\tmp\\.agents\\skills\\my-skill",
        cli: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
        contentHash,
        totalBytes: 10,
        fileCount: 1,
        files: ["SKILL.md"],
        manifestJson: { ok: true },
        meta: { name: "My Skill", description: null, tags: [] },
      },
      cleanup: async () => {},
    });
    packageSkillsShPreparedMock.mockResolvedValue({ storageUri: `/api/acp-proxy/skills/packages/${contentHash}.zip`, packageSize: 123 });

    const tx1 = {
      skill: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "skill-1",
          name: "My Skill",
          description: null,
          tags: [],
          sourceType: "skills.sh",
          sourceKey: "acme/repo@my-skill",
          latestVersionId: null,
        }),
        update: vi.fn().mockResolvedValue({ id: "skill-1", latestVersionId: "ver-1" }),
      },
      skillVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "ver-1",
          contentHash,
          storageUri: `/api/acp-proxy/skills/packages/${contentHash}.zip`,
          importedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        update: vi.fn(),
      },
      skillAuditLog: {
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
    } as any;

    const tx2 = {
      skill: {
        findFirst: vi.fn().mockResolvedValue({
          id: "skill-1",
          name: "My Skill",
          description: null,
          tags: [],
          sourceType: "skills.sh",
          sourceKey: "acme/repo@my-skill",
          latestVersionId: "ver-1",
        }),
      },
      skillVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ver-1",
          contentHash,
          storageUri: `/api/acp-proxy/skills/packages/${contentHash}.zip`,
          importedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        update: vi.fn(),
        create: vi.fn(),
      },
      skillAuditLog: {
        create: vi.fn().mockResolvedValue({ id: "a2" }),
      },
    } as any;

    let txCall = 0;
    const prisma = {
      $transaction: vi.fn(async (cb: any) => {
        txCall += 1;
        return await cb(txCall === 1 ? tx1 : tx2);
      }),
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth, skillsCli: {} as any, packages: {} as any }), {
      prefix: "/api/admin",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });

    const res1 = await server.inject({
      method: "POST",
      url: "/api/admin/skills/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: "skills.sh", sourceRef: "acme/repo@my-skill", mode: "new-skill" },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          createdSkill: true,
          createdVersion: true,
          contentHash,
        }),
      }),
    );
    expect(tx1.skillVersion.create).toHaveBeenCalledTimes(1);
    expect(tx1.skillAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "import" }) }));
    expect(tx1.skillAuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "publish_latest" }) }));

    const res2 = await server.inject({
      method: "POST",
      url: "/api/admin/skills/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: "skills.sh", sourceRef: "acme/repo@my-skill", mode: "new-version" },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          createdSkill: false,
          createdVersion: false,
          published: false,
          contentHash,
        }),
      }),
    );
    expect(tx2.skillVersion.create).not.toHaveBeenCalled();
    expect(tx2.skillAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "import",
          payload: expect.objectContaining({ idempotent: true }),
        }),
      }),
    );

    await server.close();
  });

  it("POST /api/admin/skills/import returns BAD_INPUT when sourceRef is invalid", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = { $transaction: vi.fn() } as any;

    await server.register(makeSkillRoutes({ prisma, auth, skillsCli: {} as any, packages: {} as any }), {
      prefix: "/api/admin",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/skills/import",
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: "skills.sh", sourceRef: "bad-ref", mode: "new-skill" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "BAD_INPUT", message: "sourceRef 格式错误（期望 <owner>/<repo>@<skill>）" },
    });
    expect(prepareSkillsShImportMock).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/admin/skills/update is idempotent by contentHash and writes audit logs", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const contentHash = "b".repeat(64);
    prepareSkillsShImportMock.mockResolvedValue({
      prepared: {
        source: {
          sourceType: "skills.sh",
          sourceKey: "acme/repo@my-skill",
          sourceRef: "https://skills.sh/acme/repo/my-skill",
          owner: "acme",
          repo: "repo",
          skill: "my-skill",
          githubRepoUrl: "https://github.com/acme/repo",
          skillDir: "skills/my-skill",
        },
        skillDir: "C:\\tmp\\.agents\\skills\\my-skill",
        cli: { stdout: "", stderr: "", exitCode: 0, timedOut: false },
        contentHash,
        totalBytes: 10,
        fileCount: 1,
        files: ["SKILL.md"],
        manifestJson: { ok: true },
        meta: { name: "My Skill", description: null, tags: [] },
      },
      cleanup: async () => {},
    });
    packageSkillsShPreparedMock.mockResolvedValue({ storageUri: `/api/acp-proxy/skills/packages/${contentHash}.zip`, packageSize: 123 });

    const tx = {
      skillVersion: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ver-1",
          contentHash,
          storageUri: `/api/acp-proxy/skills/packages/${contentHash}.zip`,
          importedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        update: vi.fn(),
        create: vi.fn(),
      },
      skillAuditLog: { create: vi.fn().mockResolvedValue({ id: "a1" }) },
      skill: { update: vi.fn() },
    } as any;

    const prisma = {
      skill: {
        findUnique: vi.fn().mockResolvedValue({
          id: "skill-1",
          name: "My Skill",
          sourceType: "skills.sh",
          sourceKey: "acme/repo@my-skill",
          latestVersionId: "ver-1",
        }),
      },
      $transaction: vi.fn(async (cb: any) => await cb(tx)),
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth, skillsCli: {} as any, packages: {} as any }), {
      prefix: "/api/admin",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/skills/update",
      headers: { authorization: `Bearer ${token}` },
      payload: { skillIds: ["00000000-0000-0000-0000-000000000001"], publishLatest: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          publishLatest: false,
          results: [
            expect.objectContaining({
              ok: true,
              createdVersion: false,
              published: false,
              contentHash,
            }),
          ],
        }),
      }),
    );
    expect(tx.skillVersion.create).not.toHaveBeenCalled();
    expect(tx.skillAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "update",
          payload: expect.objectContaining({ idempotent: true }),
        }),
      }),
    );

    await server.close();
  });

  it("POST /api/admin/skills/update returns UNSUPPORTED_SOURCE and skips import when skill is not skills.sh", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = {
      skill: {
        findUnique: vi.fn().mockResolvedValue({
          id: "skill-1",
          name: "My Skill",
          sourceType: "registry",
          sourceKey: null,
          latestVersionId: null,
        }),
      },
      $transaction: vi.fn(),
    } as any;

    await server.register(makeSkillRoutes({ prisma, auth, skillsCli: {} as any, packages: {} as any }), {
      prefix: "/api/admin",
    });

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "POST",
      url: "/api/admin/skills/update",
      headers: { authorization: `Bearer ${token}` },
      payload: { skillIds: ["00000000-0000-0000-0000-000000000001"], publishLatest: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        publishLatest: false,
        results: [{ skillId: "00000000-0000-0000-0000-000000000001", ok: false, error: "UNSUPPORTED_SOURCE" }],
      },
    });
    expect(prepareSkillsShImportMock).not.toHaveBeenCalled();

    await server.close();
  });
});

