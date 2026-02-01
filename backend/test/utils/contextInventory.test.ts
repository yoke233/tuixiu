import { describe, expect, it } from "vitest";

import { stringifyContextInventory } from "../../src/utils/contextInventory.js";

describe("contextInventory", () => {
  it("serializes inventory with skills", () => {
    const res = stringifyContextInventory([
      { key: "skill:demo", source: "skills", version: "v1", hash: "h1", ref: "uri" },
    ]);
    const parsed = JSON.parse(res.json);
    expect(parsed.items).toEqual([
      { key: "skill:demo", source: "skills", version: "v1", hash: "h1", ref: "uri" },
    ]);
    expect(res.path).toMatch(/context-inventory\.json$/);
  });

  it("includes generatedAt timestamp", () => {
    const res = stringifyContextInventory([]);
    const parsed = JSON.parse(res.json);
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.items).toEqual([]);
  });

  it("allows empty metadata fields", () => {
    const res = stringifyContextInventory([
      { key: "repo", source: "repo", ref: "", version: null, hash: null },
    ]);
    const parsed = JSON.parse(res.json);
    expect(parsed.items).toEqual([{ key: "repo", source: "repo", ref: "", version: null, hash: null }]);
  });

  it("stringifies non-string keys without throwing", () => {
    const res = stringifyContextInventory([
      { key: 123 as any, source: "skills", ref: 456 as any },
    ]);
    const parsed = JSON.parse(res.json);
    expect(parsed.items).toEqual([{ key: 123, source: "skills", ref: 456 }]);
  });

  it("stringifies unknown sources without throwing", () => {
    const res = stringifyContextInventory([
      { key: "x", source: "unknown" as any, ref: "y" },
    ]);
    const parsed = JSON.parse(res.json);
    expect(parsed.items).toEqual([{ key: "x", source: "unknown", ref: "y" }]);
  });
});
