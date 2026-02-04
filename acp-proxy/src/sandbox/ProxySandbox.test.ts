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
        workspaceProvider: "host",
      } as any,
      () => {},
    );
    expect(adapter.provider).toBe("container_oci");
  });

  it("creates host_process adapter", () => {
    const adapter = createProxySandbox(
      {
        provider: "host_process",
        terminalEnabled: false,
        workspaceProvider: "host",
        workspaceHostRoot: "/tmp",
      } as any,
      () => {},
    );
    expect(adapter.provider).toBe("host_process");
  });
});
