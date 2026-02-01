import { describe, expect, it } from "vitest";

import { buildWorkspaceInitScript, mergeInitScripts } from "../../src/utils/agentInit.js";

describe("agentInit", () => {
  it("mergeInitScripts trims and joins scripts", () => {
    const merged = mergeInitScripts("  a\n", "\n\n  b  ", undefined, null, "");
    expect(merged).toBe("a\n\nb");
  });

  it("mergeInitScripts returns empty for all empty inputs", () => {
    const merged = mergeInitScripts(" ", "\n\n", null, undefined);
    expect(merged).toBe("");
  });

  it("buildWorkspaceInitScript includes core init functions", () => {
    const script = buildWorkspaceInitScript();
    expect(script).toContain("init_step()");
    expect(script).toContain("ensure_workspace()");
    expect(script).toContain("init_repo()");
    expect(script).toContain("init_bundle()");
    expect(script).toContain("mount_skills()");
    expect(script).toContain("write_inventory()");
  });

  it("buildWorkspaceInitScript includes action dispatch and skip logic", () => {
    const script = buildWorkspaceInitScript();
    expect(script).toContain("TUIXIU_INIT_ACTIONS");
    expect(script).toContain("TUIXIU_SKIP_WORKSPACE_INIT");
    expect(script).toContain("workspace_mode");
  });

  it("buildWorkspaceInitScript contains workspace and bundle error branches", () => {
    const script = buildWorkspaceInitScript();
    expect(script).toContain("[init] invalid workspace");
    expect(script).toContain("[init] missing bundle file");
    expect(script).toContain("[init] unsupported bundle format");
  });

  it("buildWorkspaceInitScript contains repo init error branches", () => {
    const script = buildWorkspaceInitScript();
    expect(script).toContain("[init] missing TUIXIU_REPO_URL");
    expect(script).toContain("[init] missing TUIXIU_RUN_BRANCH");
    expect(script).toContain("[init] unzip not available");
  });
});
