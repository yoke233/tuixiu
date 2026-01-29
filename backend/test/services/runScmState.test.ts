import { describe, expect, it } from "vitest";

import { buildRunScmStateUpdate } from "../../src/modules/scm/runScmState.js";

describe("runScmState", () => {
  it("buildRunScmStateUpdate normalizes values and sets scmUpdatedAt", () => {
    const now = new Date("2026-01-28T00:00:00.000Z");
    const data = buildRunScmStateUpdate(
      {
        scmProvider: "GitHub" as any,
        scmHeadSha: "   ",
        scmPrNumber: 0,
        scmPrUrl: "",
        scmPrState: "OPENED" as any,
        scmCiStatus: "success" as any,
      },
      { now },
    );

    expect(data).toEqual({
      scmProvider: "github",
      scmHeadSha: null,
      scmPrNumber: null,
      scmPrUrl: null,
      scmPrState: "open",
      scmCiStatus: "passed",
      scmUpdatedAt: now,
    });
  });

  it("buildRunScmStateUpdate returns empty object when patch is empty", () => {
    expect(buildRunScmStateUpdate({})).toEqual({});
  });

  it("buildRunScmStateUpdate respects explicit scmUpdatedAt", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(buildRunScmStateUpdate({ scmUpdatedAt: at })).toEqual({ scmUpdatedAt: at });
  });
});
