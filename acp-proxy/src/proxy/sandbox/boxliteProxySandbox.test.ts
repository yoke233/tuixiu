import { describe, expect, it, vi } from "vitest";

import type { ProcessHandle, SandboxInstanceInfo } from "../../sandbox/types.js";

import { BoxliteProxySandbox } from "./boxliteProxySandbox.js";

function fakeHandle(): ProcessHandle {
  const io = new TransformStream<Uint8Array, Uint8Array>();
  return {
    stdin: io.writable,
    stdout: io.readable,
    stderr: io.readable,
    close: async () => {},
    onExit: () => {},
  };
}

function info(status: SandboxInstanceInfo["status"]): SandboxInstanceInfo {
  return { instanceName: "i1", status, createdAt: null };
}

describe("proxy/sandbox/boxliteProxySandbox", () => {
  it("missing -> ensure running then exec agent", async () => {
    const boxlite = {
      inspectInstance: vi.fn(async () => info("missing")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
    };

    const sandbox = new BoxliteProxySandbox({
      config: { provider: "boxlite_oci", image: "img" } as any,
      log: () => {},
      boxlite,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
    });

    expect(res.created).toBe(true);
    expect(res.initPending).toBe(false);
    expect(boxlite.ensureInstanceRunning).toHaveBeenCalledTimes(1);
    expect(boxlite.execProcess).toHaveBeenCalledTimes(1);
  });

  it("running -> does not ensure running again", async () => {
    const boxlite = {
      inspectInstance: vi.fn(async () => info("running")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
    };

    const sandbox = new BoxliteProxySandbox({
      config: { provider: "boxlite_oci", image: "img" } as any,
      log: () => {},
      boxlite,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
    });

    expect(res.created).toBe(false);
    expect(boxlite.ensureInstanceRunning).not.toHaveBeenCalled();
    expect(boxlite.execProcess).toHaveBeenCalledTimes(1);
  });
});
