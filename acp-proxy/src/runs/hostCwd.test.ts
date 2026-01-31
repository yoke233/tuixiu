import { describe, expect, it } from "vitest";

import { NativePlatform } from "../platform/native/nativePlatform.js";
import { mapCwdForHostProcess } from "./hostCwd.js";

describe("runs/hostCwd", () => {
  it("maps /workspace to host workspace path", () => {
    const out = mapCwdForHostProcess("/workspace", "D:\\workspaces\\run-1", "win32");
    expect(out.toLowerCase()).toBe("d:\\workspaces\\run-1".toLowerCase());
  });

  it("maps /workspace/sub/dir to host workspace path", () => {
    const out = mapCwdForHostProcess("/workspace/sub/dir", "D:\\workspaces\\run-1", "win32");
    expect(out.toLowerCase()).toBe("d:\\workspaces\\run-1\\sub\\dir".toLowerCase());
  });

  it("keeps Windows absolute cwd", () => {
    const out = mapCwdForHostProcess("D:\\x\\y", "D:\\workspaces\\run-1", "win32");
    expect(out.toLowerCase()).toBe("d:\\x\\y".toLowerCase());
  });

  it("maps /workspace on posix to host workspace path", () => {
    const out = mapCwdForHostProcess("/workspace/sub", "/root/workspaces/run-1", "linux");
    expect(out).toBe("/root/workspaces/run-1/sub");
  });

  it("NativePlatform.resolveCwdForAgent matches mapCwdForHostProcess on Windows", () => {
    const cwd = "/workspace/sub/dir";
    const hostWorkspacePath = "D:\\workspaces\\run-1";
    const expected = mapCwdForHostProcess(cwd, hostWorkspacePath, "win32");
    const out = new NativePlatform("win32").resolveCwdForAgent({ cwd, runHostWorkspacePath: hostWorkspacePath });
    expect(out.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("NativePlatform.resolveCwdForAgent matches mapCwdForHostProcess on POSIX", () => {
    const cwd = "/workspace/sub";
    const hostWorkspacePath = "/root/workspaces/run-1";
    const expected = mapCwdForHostProcess(cwd, hostWorkspacePath, "linux");
    const out = new NativePlatform("linux").resolveCwdForAgent({ cwd, runHostWorkspacePath: hostWorkspacePath });
    expect(out).toBe(expected);
  });
});
