import { describe, expect, it } from "vitest";

const { normalizeAgentInputs } = await import("../../../src/modules/agentInputs/agentInputsSchema.js");

describe("agentInputsSchema", () => {
  it("accepts manifest v1 writeFile + inlineText under USER_HOME", () => {
    const out = normalizeAgentInputs({
      version: 1,
      items: [
        {
          id: "agents-md",
          name: "AGENTS.md",
          apply: "writeFile",
          source: { type: "inlineText", text: "hi" },
          target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
        },
      ],
    });
    expect(out).toEqual(
      expect.objectContaining({
        version: 1,
        items: expect.arrayContaining([expect.objectContaining({ id: "agents-md" })]),
      }),
    );
  });

  it("rejects envPatch keys outside allowlist", () => {
    expect(() =>
      normalizeAgentInputs({ version: 1, envPatch: { PATH: "/tmp" }, items: [] }),
    ).toThrow();
  });

  it("rejects target.path escape attempts", () => {
    expect(() =>
      normalizeAgentInputs({
        version: 1,
        items: [
          {
            id: "escape",
            apply: "writeFile",
            source: { type: "inlineText", text: "x" },
            target: { root: "USER_HOME", path: "../escape.txt" },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects writeFile when source.type is not inlineText", () => {
    expect(() =>
      normalizeAgentInputs({
        version: 1,
        items: [
          {
            id: "bad",
            apply: "writeFile",
            source: { type: "httpZip", uri: "/x.zip" },
            target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
          },
        ],
      }),
    ).toThrow();
  });
});
