import { describe, expect, it, vi } from "vitest";

import {
  getTextTemplateRaw,
  listPlatformTextTemplates,
  patchPlatformTextTemplates,
  patchProjectTextTemplates,
  renderTextTemplateFromDb,
} from "../../src/modules/templates/textTemplates.js";

describe("textTemplates service", () => {
  it("returns missing when key empty", async () => {
    const prisma = {} as any;
    const res = await getTextTemplateRaw({ prisma }, { key: "  ", projectId: "p1" });
    expect(res).toEqual({ template: null, source: "missing" });
  });

  it("prefers project override over platform", async () => {
    const prisma = {
      projectTextTemplate: { findUnique: vi.fn().mockResolvedValue({ template: "project" }) },
      platformTextTemplate: { findUnique: vi.fn().mockResolvedValue({ template: "platform" }) },
    } as any;

    const res = await getTextTemplateRaw({ prisma }, { key: "k1", projectId: "p1" });
    expect(res.source).toBe("project");
    expect(res.template).toBe("project");
    expect(prisma.projectTextTemplate.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.platformTextTemplate.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to platform template", async () => {
    const prisma = {
      projectTextTemplate: { findUnique: vi.fn().mockResolvedValue(null) },
      platformTextTemplate: { findUnique: vi.fn().mockResolvedValue({ template: "platform" }) },
    } as any;

    const res = await getTextTemplateRaw({ prisma }, { key: "k1", projectId: "p1" });
    expect(res.source).toBe("platform");
    expect(res.template).toBe("platform");
  });

  it("renders template with vars", async () => {
    const prisma = {
      platformTextTemplate: { findUnique: vi.fn().mockResolvedValue({ template: "a{{#if x}}X{{/if}}b {{y}}" }) },
    } as any;

    const out = await renderTextTemplateFromDb({
      prisma,
    }, {
      key: "k1",
      vars: { x: "1", y: "2" },
      missingText: "missing",
    });
    expect(out).toBe("aXb 2");
  });

  it("listPlatformTextTemplates returns empty if delegate missing", async () => {
    const prisma = {} as any;
    await expect(listPlatformTextTemplates({ prisma })).resolves.toEqual({});
  });

  it("patchPlatformTextTemplates applies upsert/delete rules", async () => {
    const prisma = {
      platformTextTemplate: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await patchPlatformTextTemplates({ prisma }, { a: null, b: "", c: "  hi  " });

    expect(prisma.platformTextTemplate.deleteMany).toHaveBeenCalledWith({ where: { key: "a" } });
    expect(prisma.platformTextTemplate.deleteMany).toHaveBeenCalledWith({ where: { key: "b" } });
    expect(prisma.platformTextTemplate.upsert).toHaveBeenCalledWith({
      where: { key: "c" },
      create: { key: "c", template: "hi" },
      update: { template: "hi" },
    });
  });

  it("patchProjectTextTemplates applies upsert/delete rules", async () => {
    const prisma = {
      projectTextTemplate: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await patchProjectTextTemplates({ prisma }, { projectId: "p1", patch: { a: null, b: " ok " } });

    expect(prisma.projectTextTemplate.deleteMany).toHaveBeenCalledWith({ where: { projectId: "p1", key: "a" } });
    expect(prisma.projectTextTemplate.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId_key: { projectId: "p1", key: "b" } },
        update: { template: "ok" },
      }),
    );
  });

  it("patchPlatformTextTemplates throws when delegate missing", async () => {
    const prisma = {} as any;
    await expect(patchPlatformTextTemplates({ prisma }, { a: "x" })).rejects.toThrow("platformTextTemplate");
  });
});
