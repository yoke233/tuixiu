import { describe, expect, it } from "vitest";

import { parseGateDecision } from "../../src/services/pm/gateDecision.js";

describe("gateDecision", () => {
  it("parses valid gate decision and applies defaults", () => {
    const parsed = parseGateDecision({
      kind: "gate_decision",
      gate: "review",
      decision: "PASS",
      reasons: ["ok"],
    });

    expect(parsed).toEqual({
      kind: "gate_decision",
      version: 1,
      gate: "review",
      decision: "PASS",
      reasons: ["ok"],
      requiredActions: [],
      evidence: [],
      createdAt: undefined,
    });
  });

  it("returns null for invalid content", () => {
    expect(parseGateDecision({})).toBeNull();
    expect(parseGateDecision({ kind: "gate_decision", gate: "", decision: "PASS" })).toBeNull();
  });
});

