import { describe, expect, it } from "vitest";

import { buildInitPipeline } from "../../src/utils/initPipeline.js";

describe("initPipeline", () => {
  it("builds pipeline for git policy with skills", () => {
    const pipeline = buildInitPipeline({ policy: "git", hasSkills: true, hasBundle: false });
    expect(pipeline.actions.map((a) => a.type)).toEqual([
      "ensure_workspace",
      "init_repo",
      "mount_skills",
      "write_inventory",
    ]);
  });

  it("builds pipeline for empty policy without skills", () => {
    const pipeline = buildInitPipeline({ policy: "empty", hasSkills: false, hasBundle: false });
    expect(pipeline.actions.map((a) => a.type)).toEqual(["ensure_workspace", "write_inventory"]);
  });

  it("includes init_bundle when bundle is requested", () => {
    const pipeline = buildInitPipeline({ policy: "bundle", hasSkills: false, hasBundle: true });
    expect(pipeline.actions.map((a) => a.type)).toEqual([
      "ensure_workspace",
      "init_bundle",
      "write_inventory",
    ]);
  });

  it("includes init_bundle when hasBundle even if policy is git", () => {
    const pipeline = buildInitPipeline({ policy: "git", hasSkills: false, hasBundle: true });
    expect(pipeline.actions.map((a) => a.type)).toEqual([
      "ensure_workspace",
      "init_repo",
      "init_bundle",
      "write_inventory",
    ]);
  });

  it("includes mount_skills for empty policy when skills exist", () => {
    const pipeline = buildInitPipeline({ policy: "empty", hasSkills: true, hasBundle: false });
    expect(pipeline.actions.map((a) => a.type)).toEqual([
      "ensure_workspace",
      "mount_skills",
      "write_inventory",
    ]);
  });

  it("falls back to minimal actions for unknown policy", () => {
    const pipeline = buildInitPipeline({
      policy: "weird" as any,
      hasSkills: false,
      hasBundle: false,
    });
    expect(pipeline.actions.map((a) => a.type)).toEqual(["ensure_workspace", "write_inventory"]);
  });

  it("treats falsy flags as false without throwing", () => {
    const pipeline = buildInitPipeline({
      policy: "empty",
      hasSkills: 0 as any,
      hasBundle: "" as any,
    });
    expect(pipeline.actions.map((a) => a.type)).toEqual(["ensure_workspace", "write_inventory"]);
  });
});
