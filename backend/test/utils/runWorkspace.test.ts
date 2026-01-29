import { beforeEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import path from "node:path";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();

  (execFile as any)[promisify.custom] = (file: string, args: string[], options?: any) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err: any, stdout: any, stderr: any) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return { execFile };
});

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/utils/gitAuth.js", () => ({
  createGitProcessEnv: vi.fn(),
}));

vi.mock("../../src/utils/gitWorkspace.js", () => ({
  defaultRunBranchName: vi.fn(),
}));

const { createRunWorkspace } = await import("../../src/utils/runWorkspace.js");
const { execFile } = await import("node:child_process");
const { access, rm } = await import("node:fs/promises");
const { createGitProcessEnv } = await import("../../src/utils/gitAuth.js");
const { defaultRunBranchName } = await import("../../src/utils/gitWorkspace.js");

describe("runWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("createRunWorkspace uses mirror cache when available and removes existing workspace", async () => {
    (defaultRunBranchName as any).mockReturnValue("run-branch");
    (createGitProcessEnv as any).mockResolvedValue({
      env: { GIT_TERMINAL_PROMPT: "0" },
      gitAuthMode: "https_pat",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });

    (execFile as any).mockImplementation((file: string, args: string[], options: any, cb: any) => cb(null, "", ""));

    const workspacesRoot = path.resolve("tmp-workspaces");
    const repoCacheRoot = path.resolve("tmp-cache");
    const runId = "00000000-0000-0000-0000-000000000001";
    const workspacePath = path.join(workspacesRoot, `run-${runId}`);
    const repoCachePath = path.join(repoCacheRoot, "p1.git");

    (access as any).mockImplementation(async (p: string) => {
      if (p === workspacePath) return;
      throw new Error("missing");
    });

    const res = await createRunWorkspace({
      runId,
      baseBranch: " develop ",
      name: "Demo",
      project: { id: "p1", repoUrl: "https://example.com/repo.git" },
      workspacesRoot,
      repoCacheRoot,
    });

    expect(rm).toHaveBeenCalledWith(workspacePath, { recursive: true, force: true });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["clone", "--mirror", "https://example.com/repo.git", repoCachePath],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
      expect.any(Function),
    );
    expect(execFile).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--branch",
        "develop",
        "--single-branch",
        "--reference-if-able",
        repoCachePath,
        "https://example.com/repo.git",
        workspacePath,
      ],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
      expect.any(Function),
    );
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "run-branch"],
      { cwd: workspacePath, env: { GIT_TERMINAL_PROMPT: "0" } },
      expect.any(Function),
    );

    expect(res.workspaceMode).toBe("clone");
    expect(res.workspacePath).toBe(workspacePath);
    expect(res.branchName).toBe("run-branch");
    expect(res.baseBranch).toBe("develop");
    expect(res.repoCachePath).toBe(repoCachePath);
    expect(res.gitAuthMode).toBe("https_pat");
    expect(res.timingsMs.totalMs).toEqual(expect.any(Number));
  });

  it("createRunWorkspace continues without mirror when mirror update fails", async () => {
    (defaultRunBranchName as any).mockReturnValue("run-branch");
    const cleanup = vi.fn().mockResolvedValue(undefined);
    (createGitProcessEnv as any).mockResolvedValue({
      env: { GIT_TERMINAL_PROMPT: "0" },
      gitAuthMode: "https_pat",
      cleanup,
    });

    (execFile as any).mockImplementation((file: string, args: string[], options: any, cb: any) => {
      if (args.includes("--mirror")) {
        cb(new Error("mirror fail"), "", "x");
        return;
      }
      cb(null, "", "");
    });

    (access as any).mockRejectedValue(new Error("missing"));

    const workspacesRoot = path.resolve("tmp-workspaces");
    const repoCacheRoot = path.resolve("tmp-cache");
    const runId = "00000000-0000-0000-0000-000000000002";
    const workspacePath = path.join(workspacesRoot, `run-${runId}`);
    const repoCachePath = path.join(repoCacheRoot, "p2.git");

    const res = await createRunWorkspace({
      runId,
      baseBranch: "main",
      name: "Demo",
      project: { id: "p2", repoUrl: "https://example.com/repo.git" },
      workspacesRoot,
      repoCacheRoot,
    });

    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["clone", "--mirror", "https://example.com/repo.git", repoCachePath],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
      expect.any(Function),
    );

    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["clone", "--branch", "main", "--single-branch", "https://example.com/repo.git", workspacePath],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
      expect.any(Function),
    );

    expect(res.repoCachePath).toBeUndefined();
    expect(cleanup).toHaveBeenCalled();
  });
});
