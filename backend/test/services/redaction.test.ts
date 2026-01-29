import { describe, expect, it } from "vitest";

import { redactText, scanForSecrets } from "../../src/modules/security/redaction.js";

describe("redaction", () => {
  it("scanForSecrets detects known tokens", () => {
    const input = "token: ghp_12345678901234567890ABCDE and key sk-12345678901234567890ABCDE";
    const res = scanForSecrets(input);
    expect(res.ok).toBe(false);
    expect(res.matches.map((m) => m.name)).toContain("GitHub classic token");
    expect(res.matches.map((m) => m.name)).toContain("OpenAI key");
  });

  it("redactText masks secrets and scanForSecrets becomes ok", () => {
    const token = "ghp_12345678901234567890ABCDE";
    const out = redactText(`hello ${token} world`);
    expect(out).toBe(`hello ${token.slice(0, 6)}…REDACTED…${token.slice(-4)} world`);
    expect(scanForSecrets(out).ok).toBe(true);
  });
});
