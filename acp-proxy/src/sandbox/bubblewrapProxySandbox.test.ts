import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => {
  return {
    spawn: spawnMock,
  };
});

import { BubblewrapProxySandbox } from "./bubblewrapProxySandbox.js";

function makeFakeChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

describe("proxy/sandbox/bubblewrap", () => {
  let rootDir = "";
  let hostCodexCfg = "";

  beforeEach(async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChildProcess());
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-bwrap-"));
    hostCodexCfg = path.join(rootDir, "codex-config.toml");
    await fs.writeFile(hostCodexCfg, "test = true\n", "utf8");
  });

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it(process.platform === "linux" ? "spawns bwrap with workspace bind + ro-bind volume" : "rejects on non-linux", async () => {
    const sandbox = new BubblewrapProxySandbox({
      config: {
        provider: "bwrap",
        terminalEnabled: false,
        workspaceProvider: "host",
        workspaceHostRoot: rootDir,
        volumes: [{ hostPath: hostCodexCfg, guestPath: "/root/.codex/config.toml", readOnly: true }],
      } as any,
      log: () => {},
    });

    await sandbox.ensureInstanceRunning({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestPath: "/workspace",
    });

    if (process.platform !== "linux") {
      await expect(
        sandbox.execProcess({
          instanceName: "inst1",
          command: ["node", "--version"],
          cwdInGuest: "/workspace/sub/dir",
        }),
      ).rejects.toThrow(/Linux/);
      expect(spawnMock).not.toHaveBeenCalled();
      return;
    }

    const expectedWorkspaceHostPath = path.resolve(rootDir, "run-r1");
    const worktreeGitDir = path.resolve(rootDir, "_repo-cache", "abc", ".git", "worktrees", "run-r1");
    await fs.mkdir(worktreeGitDir, { recursive: true });
    await fs.writeFile(path.join(expectedWorkspaceHostPath, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    await sandbox.execProcess({
      instanceName: "inst1",
      command: ["node", "--version"],
      cwdInGuest: "/workspace/sub/dir",
    });

    const firstCall = spawnMock.mock.calls[0] ?? null;
    expect(firstCall).not.toBeNull();
    const [calledCmd, calledArgs, calledOpts] = firstCall as any[];
    expect(String(calledCmd)).toBe("bwrap");
    expect(calledOpts?.cwd).toBe(expectedWorkspaceHostPath);

    const args = calledArgs as string[];
    expect(args).toEqual(expect.arrayContaining(["--bind", expectedWorkspaceHostPath, "/workspace"]));
    expect(args).toEqual(
      expect.arrayContaining(["--bind", path.resolve(rootDir, "_repo-cache", "abc", ".git"), path.resolve(rootDir, "_repo-cache", "abc", ".git")]),
    );
    expect(args).toEqual(expect.arrayContaining(["--ro-bind", path.resolve(hostCodexCfg), "/root/.codex/config.toml"]));
    expect(args).toEqual(expect.arrayContaining(["--chdir", "/workspace/sub/dir"]));
    expect(args).toEqual(expect.arrayContaining(["--", "node", "--version"]));
  });
});
