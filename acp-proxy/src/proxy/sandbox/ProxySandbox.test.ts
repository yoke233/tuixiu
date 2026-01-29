import { describe, expect, it } from "vitest";

import { createProxySandbox } from "./createProxySandbox.js";

describe("proxy/sandbox/createProxySandbox", () => {
  it("creates sandbox adapter", () => {
    const adapter = createProxySandbox(
      {
        provider: "container_oci",
        runtime: "docker",
        image: "alpine:latest",
        workingDir: "/workspace",
        terminalEnabled: false,
        workspaceMode: "mount",
      } as any,
      () => {},
    );
    expect(adapter.provider).toBe("container_oci");
  });
});
