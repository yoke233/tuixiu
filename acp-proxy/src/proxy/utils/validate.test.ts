import { describe, expect, it } from "vitest";

import { validateInstanceName, validateRunId } from "./validate.js";

describe("proxy/utils/validate", () => {
  it("rejects empty run_id", () => {
    expect(() => validateRunId("")).toThrow(/run_id/);
  });

  it("rejects run_id with path separators", () => {
    expect(() => validateRunId("a/b")).toThrow();
  });

  it("accepts instance_name basic", () => {
    expect(validateInstanceName("abc-1_.")).toBe("abc-1_.");
  });
});
