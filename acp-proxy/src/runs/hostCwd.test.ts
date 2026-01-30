import { describe, expect, it } from "vitest";

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
});
