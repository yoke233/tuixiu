import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createLocalSkillPackageStore } from "../../../src/modules/skills/skillPackageStore.js";

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-store-"));
  try {
    return await task(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("skillPackageStore", () => {
  it("stores zip file and returns info", async () => {
    await withTempDir(async (dir) => {
      const hash = "a".repeat(64);
      const zipFile = path.join(dir, "skill.zip");
      await fs.writeFile(zipFile, "zip", "utf8");

      const store = createLocalSkillPackageStore({
        rootDir: path.join(dir, "store"),
        basePath: "/api/skills",
        maxBytes: 0,
      });

      const stored = await store.putZipFile({ contentHash: hash, zipFilePath: zipFile });
      expect(stored.storageUri).toBe(`/api/skills/${encodeURIComponent(hash)}.zip`);

      const info = await store.getInfo({ contentHash: hash });
      expect(info?.filePath).toBe(stored.filePath);
      expect(info?.size).toBeGreaterThan(0);
    });
  });

  it("is idempotent for existing package", async () => {
    await withTempDir(async (dir) => {
      const hash = "b".repeat(64);
      const zipFile = path.join(dir, "skill.zip");
      await fs.writeFile(zipFile, "zip", "utf8");

      const store = createLocalSkillPackageStore({
        rootDir: path.join(dir, "store"),
        basePath: "/api/skills",
        maxBytes: 0,
      });

      const first = await store.putZipFile({ contentHash: hash, zipFilePath: zipFile });
      const second = await store.putZipFile({ contentHash: hash, zipFilePath: zipFile });
      expect(second.filePath).toBe(first.filePath);
      expect(second.size).toBe(first.size);
    });
  });

  it("rejects invalid hash or empty zip", async () => {
    await withTempDir(async (dir) => {
      const store = createLocalSkillPackageStore({
        rootDir: path.join(dir, "store"),
        basePath: "/api/skills",
        maxBytes: 0,
      });

      await expect(store.putZipFile({ contentHash: "bad", zipFilePath: "x" })).rejects.toThrow(
        "INVALID_HASH",
      );

      const emptyZip = path.join(dir, "empty.zip");
      await fs.writeFile(emptyZip, "");
      await expect(
        store.putZipFile({ contentHash: "c".repeat(64), zipFilePath: emptyZip }),
      ).rejects.toThrow("EMPTY_ZIP");
    });
  });

  it("rejects zip larger than max bytes", async () => {
    await withTempDir(async (dir) => {
      const zipFile = path.join(dir, "big.zip");
      await fs.writeFile(zipFile, "12345", "utf8");

      const store = createLocalSkillPackageStore({
        rootDir: path.join(dir, "store"),
        basePath: "/api/skills",
        maxBytes: 2,
      });

      await expect(
        store.putZipFile({ contentHash: "d".repeat(64), zipFilePath: zipFile }),
      ).rejects.toThrow("FILE_TOO_LARGE");
    });
  });

  it("returns null for missing or invalid hash", async () => {
    await withTempDir(async (dir) => {
      const store = createLocalSkillPackageStore({
        rootDir: path.join(dir, "store"),
        basePath: "/api/skills",
        maxBytes: 0,
      });

      expect(await store.getInfo({ contentHash: "bad" })).toBeNull();
      expect(await store.getInfo({ contentHash: "e".repeat(64) })).toBeNull();
    });
  });
});
