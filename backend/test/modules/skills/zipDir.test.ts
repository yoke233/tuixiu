import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { zipDirToFile } from "../../../src/modules/skills/zipDir.js";

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-zip-"));
  try {
    return await task(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("zipDirToFile", () => {
  it("creates zip file with expected file count", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, "sub"), { recursive: true });
      await fs.writeFile(path.join(dir, "a.txt"), "hello", "utf8");
      await fs.writeFile(path.join(dir, "sub", "b.txt"), "world", "utf8");

      const outFile = path.join(dir, "out.zip");
      const out = await zipDirToFile({ dir, outFile });
      const stat = await fs.stat(outFile);

      expect(out.fileCount).toBe(2);
      expect(out.bytes).toBe(stat.size);
      expect(stat.size).toBeGreaterThan(0);
    });
  });
});
