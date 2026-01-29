import { describe, expect, it } from "vitest";

import { runProxyCli } from "./runProxyCli.js";

describe("proxy/runProxyCli", () => {
  it("exports runProxyCli", () => {
    expect(typeof runProxyCli).toBe("function");
  });
});
