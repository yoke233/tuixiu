import { describe, expect, it } from "vitest";
import { getSandboxWorkspaceMode, isSandboxGitClone } from "../../src/utils/sandboxCaps.js";

describe("sandboxCaps", () => {
  it("detects git_clone", () => {
    const caps = { sandbox: { provider: "container_oci", workspaceMode: "git_clone" } };
    expect(getSandboxWorkspaceMode(caps)).toBe("git_clone");
    expect(isSandboxGitClone(caps)).toBe(true);
  });

  it("returns null/false for missing or mount", () => {
    expect(getSandboxWorkspaceMode(null)).toBe(null);
    expect(isSandboxGitClone({ sandbox: { workspaceMode: "mount" } })).toBe(false);
  });
});
