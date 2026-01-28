import { describe, expect, it } from "vitest";

import { listEnvKeys, parseEnvText } from "../../src/utils/envText.js";

describe("envText", () => {
  it("parseEnvText parses .env style text", () => {
    const parsed = parseEnvText(`
      # comment
      export A=1
      B="2"
      C='3'
      D=
      INVALID
      =NO
      X =  hello
    `);

    expect(parsed).toEqual({ A: "1", B: "2", C: "3", D: "", X: "hello" });
  });

  it("listEnvKeys returns sorted keys", () => {
    expect(listEnvKeys("B=2\nA=1\n")).toEqual(["A", "B"]);
  });
});

