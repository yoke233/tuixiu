import { describe, expect, it, vi } from "vitest";

import type { ProcessHandle, SandboxInstanceInfo } from "./types.js";

import { OciCliProxySandbox } from "./ociCliProxySandbox.js";

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

describe("proxy/sandbox/ociCliProxySandbox", () => {
  it("missing -> starts via oci cli runner", async () => {
    const startAgent = vi.fn(() => fakeHandle());
    const container = {
      inspectInstance: vi.fn(async () => info("missing")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
      attachInstance: vi.fn(async () => fakeHandle()),
      startAndAttachInstance: vi.fn(async () => fakeHandle()),
      getInstanceLabels: vi.fn(async () => ({})),
    };

    const sandbox = new OciCliProxySandbox({
      config: { provider: "container_oci", runtime: "docker", image: "alpine:latest" } as any,
      log: () => {},
      container,
      startAgent: startAgent as any,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
      init: undefined,
    });

    expect(res.created).toBe(true);
    expect(res.initPending).toBe(false);
    expect(startAgent).toHaveBeenCalledTimes(1);
    expect(container.attachInstance).not.toHaveBeenCalled();
  });

  it("running + init.script -> removes and recreates", async () => {
    const startAgent = vi.fn(() => fakeHandle());
    const container = {
      inspectInstance: vi.fn(async () => info("running")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
      attachInstance: vi.fn(async () => fakeHandle()),
      startAndAttachInstance: vi.fn(async () => fakeHandle()),
      getInstanceLabels: vi.fn(async () => ({ "acp-proxy.agent_mode": "entrypoint" })),
    };

    const sandbox = new OciCliProxySandbox({
      config: { provider: "container_oci", runtime: "docker", image: "alpine:latest" } as any,
      log: () => {},
      container,
      startAgent: startAgent as any,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
      init: { script: "echo hi" },
    });

    expect(container.removeInstance).toHaveBeenCalledTimes(1);
    expect(res.created).toBe(true);
    expect(res.initPending).toBe(true);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  it("running + agent_mode mismatch -> throws", async () => {
    const startAgent = vi.fn(() => fakeHandle());
    const container = {
      inspectInstance: vi.fn(async () => info("running")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
      attachInstance: vi.fn(async () => fakeHandle()),
      startAndAttachInstance: vi.fn(async () => fakeHandle()),
      getInstanceLabels: vi.fn(async () => ({ "acp-proxy.agent_mode": "exec" })),
    };

    const sandbox = new OciCliProxySandbox({
      config: { provider: "container_oci", runtime: "docker", image: "alpine:latest" } as any,
      log: () => {},
      container,
      startAgent: startAgent as any,
    });

    await expect(
      sandbox.openAgent({
        runId: "r1",
        instanceName: "i1",
        workspaceGuestPath: "/workspace",
        agentCommand: ["node", "--version"],
        init: undefined,
      }),
    ).rejects.toThrow(/entrypoint/);

    expect(startAgent).not.toHaveBeenCalled();
    expect(container.attachInstance).not.toHaveBeenCalled();
  });

  it("running -> attaches", async () => {
    const startAgent = vi.fn(() => fakeHandle());
    const container = {
      inspectInstance: vi.fn(async () => info("running")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
      attachInstance: vi.fn(async () => fakeHandle()),
      startAndAttachInstance: vi.fn(async () => fakeHandle()),
      getInstanceLabels: vi.fn(async () => ({ "acp-proxy.agent_mode": "entrypoint" })),
    };

    const sandbox = new OciCliProxySandbox({
      config: { provider: "container_oci", runtime: "docker", image: "alpine:latest" } as any,
      log: () => {},
      container,
      startAgent: startAgent as any,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
      init: undefined,
    });

    expect(res.created).toBe(false);
    expect(container.attachInstance).toHaveBeenCalledTimes(1);
    expect(startAgent).not.toHaveBeenCalled();
  });

  it("stopped -> startAndAttach", async () => {
    const startAgent = vi.fn(() => fakeHandle());
    const container = {
      inspectInstance: vi.fn(async () => info("stopped")),
      listInstances: vi.fn(async () => []),
      ensureInstanceRunning: vi.fn(async () => info("running")),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: vi.fn(async () => {}),
      execProcess: vi.fn(async () => fakeHandle()),
      attachInstance: vi.fn(async () => fakeHandle()),
      startAndAttachInstance: vi.fn(async () => fakeHandle()),
      getInstanceLabels: vi.fn(async () => ({ "acp-proxy.agent_mode": "entrypoint" })),
    };

    const sandbox = new OciCliProxySandbox({
      config: { provider: "container_oci", runtime: "docker", image: "alpine:latest" } as any,
      log: () => {},
      container,
      startAgent: startAgent as any,
    });

    const res = await sandbox.openAgent({
      runId: "r1",
      instanceName: "i1",
      workspaceGuestPath: "/workspace",
      agentCommand: ["node", "--version"],
      init: undefined,
    });

    expect(res.created).toBe(false);
    expect(container.startAndAttachInstance).toHaveBeenCalledTimes(1);
    expect(container.attachInstance).not.toHaveBeenCalled();
    expect(startAgent).not.toHaveBeenCalled();
  });
});
