import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

import { flushMicrotasks } from "../test-utils.js";

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));

const { startWorkspaceCleanupLoop } = await import("../../src/modules/workspace/workspaceCleanup.js");
const { readdir, rm, stat } = await import("node:fs/promises");

describe("workspaceCleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cleans clone workspaces inside root and skips unexpected paths", async () => {
    (readdir as any).mockRejectedValue(new Error("no repo cache dir"));
    (rm as any).mockResolvedValue(undefined);

    const workspacesRoot = path.resolve("tmp-workspaces-root");
    const inside = path.join(workspacesRoot, "run-0001");
    const outside = path.join(path.resolve("other-root"), "run-0002");
    const unexpectedName = path.join(workspacesRoot, "x-0003");

    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([
          { id: "r1", workspacePath: inside, completedAt: new Date(0) },
          { id: "r2", workspacePath: outside, completedAt: new Date(0) },
          { id: "r3", workspacePath: unexpectedName, completedAt: new Date(0) },
          { id: "r4", workspacePath: workspacesRoot, completedAt: new Date(0) },
        ]),
      },
    } as any;

    const log = vi.fn();

    startWorkspaceCleanupLoop({
      prisma,
      workspacesRoot,
      repoCacheRoot: path.resolve("tmp-repo-cache-root"),
      workspaceTtlDays: 1,
      repoCacheTtlDays: 30,
      intervalSeconds: 999999,
      log,
    });

    await flushMicrotasks();

    expect(rm).toHaveBeenCalledWith(inside, { recursive: true, force: true });
    expect(log).toHaveBeenCalledWith("skip workspace cleanup (outside root)", {
      runId: "r2",
      workspacePath: outside,
    });
    expect(log).toHaveBeenCalledWith("skip workspace cleanup (unexpected name)", {
      runId: "r3",
      workspacePath: unexpectedName,
    });
  });

  it("cleans repo cache .git dirs by mtime", async () => {
    const repoCacheRoot = path.resolve("tmp-repo-cache-root");
    const oldGit = path.join(repoCacheRoot, "a.git");
    const newGit = path.join(repoCacheRoot, "b.git");

    (readdir as any).mockResolvedValue([
      { name: "a.git", isDirectory: () => true },
      { name: "b.git", isDirectory: () => true },
      { name: "c.txt", isDirectory: () => false },
    ]);

    const now = Date.now();
    (stat as any).mockImplementation(async (p: string) => ({
      mtime: new Date(p === oldGit ? now - 1000 * 60 * 60 * 24 * 365 : now),
    }));
    (rm as any).mockResolvedValue(undefined);

    const prisma = { run: { findMany: vi.fn().mockResolvedValue([]) } } as any;
    const log = vi.fn();

    startWorkspaceCleanupLoop({
      prisma,
      workspacesRoot: path.resolve("tmp-workspaces-root"),
      repoCacheRoot,
      workspaceTtlDays: 1,
      repoCacheTtlDays: 30,
      intervalSeconds: 999999,
      log,
    });

    await flushMicrotasks();

    expect(rm).toHaveBeenCalledWith(oldGit, { recursive: true, force: true });
    expect(rm).not.toHaveBeenCalledWith(newGit, { recursive: true, force: true });
  });
});
