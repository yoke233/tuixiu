import { describe, expect, it } from "vitest";
import { getSandboxWorkspaceProvider, isSandboxWorkspaceGuest } from "../../src/utils/sandboxCaps.js";

describe("sandboxCaps", () => {
  it("detects workspaceProvider", () => {
    const caps = { sandbox: { provider: "container_oci", workspaceProvider: "guest" } };
    expect(getSandboxWorkspaceProvider(caps)).toBe("guest");
    expect(isSandboxWorkspaceGuest(caps)).toBe(true);
  });

  it("returns null/false for missing or host", () => {
    expect(getSandboxWorkspaceProvider(null)).toBe(null);
    expect(isSandboxWorkspaceGuest({ sandbox: { workspaceProvider: "host" } })).toBe(false);
  });
});
