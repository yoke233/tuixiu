import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";

const execFile = vi.fn();
const access = vi.fn();
const mkdir = vi.fn();

(execFile as any)[promisify.custom] = (file: string, args: unknown[], options: unknown) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err: any, stdout: string, stderr: string) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });

vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:fs/promises", () => ({ access, mkdir }));

async function importFresh() {
  vi.resetModules();
  return await import("../../src/utils/gitWorkspace.js");
}

describe("gitWorkspace", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  it("suggestRunKey builds stable ascii key", async () => {
    const { suggestRunKey } = await importFresh();
    expect(
      suggestRunKey({ title: "Hello World", externalProvider: "github", externalNumber: 9, runNumber: 2 }),
    ).toBe("gh-9-hello-world-r2");
    expect(suggestRunKey({ title: "", externalProvider: null, externalNumber: null, runNumber: 3 })).toBe("run-r3");
  });

  it("suggestRunKeyWithLlm returns fallback when disabled", async () => {
    const { suggestRunKeyWithLlm } = await importFresh();
    const res = await suggestRunKeyWithLlm({ title: "修复 漏洞", externalProvider: "github", externalNumber: 9, runNumber: 2 });
    expect(res).toBe("gh-9-r2");
  });

  it("suggestRunKeyWithLlm uses LLM slug for non-ascii titles when enabled", async () => {
    process.env.WORKTREE_NAME_LLM = "1";
    process.env.WORKTREE_NAME_LLM_API_KEY = "tok";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "fix-security" } }] }),
        text: async () => "",
      } as any),
    );

    const { suggestRunKeyWithLlm } = await importFresh();
    const res = await suggestRunKeyWithLlm({ title: "修复 漏洞", externalProvider: "github", externalNumber: 9, runNumber: 2 });
    expect(res).toBe("gh-9-fix-security-r2");
  });

  it("getRepoRoot caches git rev-parse result", async () => {
    execFile.mockImplementation((file: string, args: any[], options: any, cb: any) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cb(null, "D:\\repo\n", "");
      return cb(new Error("unexpected"), "", "");
    });

    const { getRepoRoot } = await importFresh();
    await expect(getRepoRoot()).resolves.toBe("D:\\repo");
    await expect(getRepoRoot()).resolves.toBe("D:\\repo");
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("createRunWorktree creates .worktrees dir and adds worktree", async () => {
    execFile.mockImplementation((file: string, args: any[], options: any, cb: any) => {
      const cmd = `${file} ${(args ?? []).join(" ")}`;
      if (cmd.startsWith("git rev-parse --show-toplevel")) return cb(null, "D:\\repo\n", "");
      if (cmd.startsWith("git show-ref --verify --quiet")) return cb(new Error("not found"), "", "");
      if (cmd.startsWith("git rev-parse --verify main")) return cb(new Error("missing"), "", "");
      if (cmd.startsWith("git fetch origin main")) return cb(null, "", "");
      if (cmd.startsWith("git worktree add")) return cb(null, "", "");
      return cb(new Error(`unexpected: ${cmd}`), "", "");
    });
    access.mockRejectedValue(new Error("ENOENT"));
    mkdir.mockResolvedValue(undefined);

    const { createRunWorktree } = await importFresh();
    const res = await createRunWorktree({ runId: "r1", baseBranch: "main", name: "Hello World" });

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining(".worktrees"), { recursive: true });
    expect(execFile.mock.calls.some((c: any[]) => String(c[1]?.join(" ")).startsWith("fetch origin main"))).toBe(true);
    expect(res.branchName).toContain("run/");
    expect(res.workspacePath).toContain(".worktrees");
  });

  it("createRunWorktree throws when name normalizes to empty", async () => {
    execFile.mockImplementation((file: string, args: any[], options: any, cb: any) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return cb(null, "D:\\repo\n", "");
      return cb(new Error("unexpected"), "", "");
    });
    access.mockRejectedValue(new Error("ENOENT"));
    mkdir.mockResolvedValue(undefined);

    const { createRunWorktree } = await importFresh();
    await expect(createRunWorktree({ runId: "r1", baseBranch: "main", name: "??" })).rejects.toThrow(/无法生成合法/);
  });
});
