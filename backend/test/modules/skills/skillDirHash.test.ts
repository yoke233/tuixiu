import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { computeSkillDirContentHash } from "../../../src/modules/skills/skillDirHash.js";

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-hash-"));
  try {
    return await task(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("skillDirHash", () => {
  it("hashes nested files with stable ordering", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "nested"), { recursive: true });
      await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");
      await fs.writeFile(path.join(dir, "nested", "b.txt"), "world", "utf8");

      const first = await computeSkillDirContentHash({ rootDir: dir });
      const second = await computeSkillDirContentHash({ rootDir: dir });

      expect(first.fileCount).toBe(2);
      expect(first.totalBytes).toBe(10);
      expect(first.files).toEqual(["a.txt", "nested/b.txt"]);
      expect(second.contentHash).toBe(first.contentHash);
    });
  });

  it("changes hash when file contents change", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");
      const before = await computeSkillDirContentHash({ rootDir: dir });
      await fs.writeFile(path.join(dir, "a.txt"), "hello!", "utf8");
      const after = await computeSkillDirContentHash({ rootDir: dir });
      expect(after.contentHash).not.toBe(before.contentHash);
    });
  });
});
