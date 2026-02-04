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

import { HostProcessProxySandbox } from "./hostProcessProxySandbox.js";

function makeFakeChildProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

describe("proxy/sandbox/host_process resolveHostCwd", () => {
  let rootDir = "";

  beforeEach(async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChildProcess());
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-host-process-"));
  });

  afterEach(async () => {
    if (rootDir) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("resolves guest cwd under /workspace to host workspace path", async () => {
    const sandbox = new HostProcessProxySandbox({
      config: { provider: "host_process", terminalEnabled: false, workspaceProvider: "host", workspaceHostRoot: rootDir } as any,
      log: () => {},
    });

    await sandbox.ensureInstanceRunning({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestPath: "/workspace",
    });

    await sandbox.execProcess({
      instanceName: "inst1",
      command: ["node", "--version"],
      cwdInGuest: "/workspace/sub/dir",
    });

    const expectedWorkspaceHostPath = path.resolve(rootDir, "run-r1");
    const expectedCwd = path.resolve(expectedWorkspaceHostPath, path.join("sub", "dir"));
    const firstCall = spawnMock.mock.calls[0] ?? null;
    expect(firstCall).not.toBeNull();
    const [calledCmd, calledArgs, calledOpts] = firstCall as any[];
    expect(calledOpts?.cwd).toBe(expectedCwd);

    if (process.platform === "win32") {
      // Windows 下：若命中 *.cmd shim（npm/pnpm/npx/codex-acp 等）会走 cmd.exe；普通 exe 则可直接运行。
      if (String(calledCmd).toLowerCase() === "cmd.exe") {
        expect(calledArgs).toEqual(expect.arrayContaining(["/c"]));
      } else {
        expect(String(calledCmd).toLowerCase()).toBe("node");
        expect(calledArgs).toEqual(["--version"]);
      }
    } else {
      expect(String(calledCmd)).toBe("node");
      expect(calledArgs).toEqual(["--version"]);
    }
  });

  it("rejects when instance is missing", async () => {
    const sandbox = new HostProcessProxySandbox({
      config: { provider: "host_process", terminalEnabled: false, workspaceProvider: "host", workspaceHostRoot: rootDir } as any,
      log: () => {},
    });

    await expect(
      sandbox.execProcess({
        instanceName: "missing",
        command: ["node", "--version"],
        cwdInGuest: "/workspace",
      }),
    ).rejects.toThrow(/instance missing/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects guest cwd outside /workspace", async () => {
    const sandbox = new HostProcessProxySandbox({
      config: { provider: "host_process", terminalEnabled: false, workspaceProvider: "host", workspaceHostRoot: rootDir } as any,
      log: () => {},
    });

    await sandbox.ensureInstanceRunning({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestPath: "/workspace",
    });

    await expect(
      sandbox.execProcess({
        instanceName: "inst1",
        command: ["node", "--version"],
        cwdInGuest: "/etc",
      }),
    ).rejects.toThrow(/cwd outside workspace/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects Windows absolute path injection via guest cwd", async () => {
    const sandbox = new HostProcessProxySandbox({
      config: { provider: "host_process", terminalEnabled: false, workspaceProvider: "host", workspaceHostRoot: rootDir } as any,
      log: () => {},
    });

    await sandbox.ensureInstanceRunning({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestPath: "/workspace",
    });

    await expect(
      sandbox.execProcess({
        instanceName: "inst1",
        command: ["node", "--version"],
        cwdInGuest: "C:\\Windows",
      }),
    ).rejects.toThrow(/cwd outside workspace/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
