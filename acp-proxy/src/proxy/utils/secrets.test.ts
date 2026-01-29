import { describe, expect, it } from "vitest";

import { pickSecretValues, redactSecrets } from "./secrets.js";

describe("proxy/utils/secrets", () => {
  it("pickSecretValues: returns only known keys and length>=6", () => {
    const values = pickSecretValues({
      OPENAI_API_KEY: "sk-123456",
      GITHUB_TOKEN: "ghp_123456",
      SHORT: "123",
      OTHER: "abcdefg",
    });
    expect(values).toContain("sk-123456");
    expect(values).toContain("ghp_123456");
    expect(values).not.toContain("abcdefg");
  });

  it("redactSecrets: replaces secret occurrences", () => {
    const out = redactSecrets("hello sk-123456 world", ["sk-123456"]);
    expect(out).toBe("hello [REDACTED] world");
  });
});
