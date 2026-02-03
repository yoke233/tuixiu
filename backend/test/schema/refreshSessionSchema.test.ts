import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("schema", () => {
  it("contains RefreshSession model", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/model\s+RefreshSession\b/);
  });
});
