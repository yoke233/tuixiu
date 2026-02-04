import { describe, expect, it } from "vitest";

import { assertWorkspacePolicyCompat, resolveWorkspacePolicy } from "../../src/utils/workspacePolicy.js";

describe("workspacePolicy", () => {
  it("resolves by precedence task > role > project > profile", () => {
    const res = resolveWorkspacePolicy({
      projectPolicy: "mount",
      rolePolicy: "empty",
      taskPolicy: "bundle",
      profilePolicy: "git",
    });

    expect(res.resolved).toBe("bundle");
    expect(res.source).toBe("task");
  });

  it("falls back to profile when task/role/project missing", () => {
    const res = resolveWorkspacePolicy({
      projectPolicy: null,
      rolePolicy: null,
      taskPolicy: null,
      profilePolicy: "empty",
    });

    expect(res.resolved).toBe("empty");
    expect(res.source).toBe("profile");
  });

  it("ignores invalid policies and falls back to default git", () => {
    const res = resolveWorkspacePolicy({
      projectPolicy: "bogus",
      rolePolicy: "nope",
      taskPolicy: "",
      profilePolicy: null,
    });

    expect(res.resolved).toBe("git");
    expect(res.source).toBe("platform");
  });

  it("does not throw when capabilities are missing", () => {
    expect(() =>
      assertWorkspacePolicyCompat({
        policy: "empty",
        capabilities: null,
      }),
    ).not.toThrow();
  });

  it("rejects incompatible mount policy when caps are git_clone", () => {
    expect(() =>
      assertWorkspacePolicyCompat({
        policy: "mount",
        capabilities: { sandbox: { workspaceProvider: "guest" } },
      }),
    ).toThrow("Agent 不支持 mount workspace 模式");
  });

  it("rejects incompatible git policy when caps are mount", () => {
    expect(() =>
      assertWorkspacePolicyCompat({
        policy: "git",
        capabilities: { sandbox: { workspaceProvider: "host" } },
      }),
    ).toThrow("Agent 不支持 git workspace 模式");
  });
});
