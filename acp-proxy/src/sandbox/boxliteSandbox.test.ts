import { describe, expect, it } from "vitest";

import { BoxliteSandbox } from "./boxliteSandbox.js";

describe("BoxliteSandbox", () => {
  it("fails fast on Windows", async () => {
    if (process.platform !== "win32") return;
    const sandbox = new BoxliteSandbox({
      log: () => {},
      config: { image: "alpine:latest" },
    });
    await expect(
      sandbox.runProcess({
        command: ["node", "--version"],
        cwd: process.cwd(),
        env: {},
      }),
    ).rejects.toThrow(/Windows/i);
  });

  it("rejects workingDir outside /workspace", async () => {
    if (process.platform === "win32") return;
    const sandbox = new BoxliteSandbox({
      log: () => {},
      config: { image: "alpine:latest", workingDir: "/tmp" },
    });
    await expect(
      sandbox.runProcess({
        command: ["node", "--version"],
        cwd: process.cwd(),
        env: {},
      }),
    ).rejects.toThrow(/workingDir/i);
  });
});
