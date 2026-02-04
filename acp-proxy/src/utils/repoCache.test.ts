import { describe, expect, it } from "vitest";
import path from "node:path";

import { hashRepoUrl, resolveRepoCacheDir, resolveRepoLockPath } from "./repoCache.js";

describe("repoCache", () => {
  it("hashRepoUrl is stable", () => {
    expect(hashRepoUrl("https://example.com/repo.git")).toMatch(/^[a-f0-9]{40}$/);
    expect(hashRepoUrl("https://example.com/repo.git")).toBe(
      hashRepoUrl("https://example.com/repo.git"),
    );
  });

  it("resolves cache dir under root", () => {
    const root = path.resolve("C:/tmp/workspaces");
    const dir = resolveRepoCacheDir(root, "https://example.com/repo.git");
    expect(dir.startsWith(path.join(root, "_repo-cache"))).toBe(true);
  });

  it("resolves lock path", () => {
    const root = path.resolve("C:/tmp/workspaces");
    const lock = resolveRepoLockPath(root, "https://example.com/repo.git");
    expect(lock.startsWith(path.join(root, "_repo-cache", "_locks"))).toBe(true);
    expect(lock.endsWith(".lock")).toBe(true);
  });
});
