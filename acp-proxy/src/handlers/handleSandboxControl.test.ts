import { describe, expect, it, vi } from "vitest";

import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RunManager } from "../runs/runManager.js";
import type { ProxySandbox } from "../sandbox/ProxySandbox.js";

import { handleSandboxControl } from "./handleSandboxControl.js";

function baseConfig(): any {
  return {
    orchestrator_url: "ws://127.0.0.1:0",
    auth_token: "",
    heartbeat_seconds: 1,
    mock_mode: false,
    sandbox: {
      terminalEnabled: true,
      provider: "boxlite_oci",
      image: "img",
      workingDir: "/workspace",
      workspaceHostRoot: "C:/tmp",
    },
    agent_command: ["node", "-e", "console.log('ok')"],
    agent: { id: "a1", name: "a1", max_concurrent: 1, capabilities: {} },
  };
}

describe("handleSandboxControl", () => {
  it("sandbox_control remove emits sandbox_inventory.deleted_instances and ok result", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "missing",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => []),
      stopInstance: async () => {},
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const ctx = {
      cfg: baseConfig(),
      sandbox,
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    await handleSandboxControl(ctx as any, {
      type: "sandbox_control",
      action: "remove",
      run_id: "r1",
      instance_name: "tuixiu-run-r1",
    });

    expect(sandbox.removeInstance).toHaveBeenCalledWith("tuixiu-run-r1");
    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "sandbox_control_result" &&
          (m as any).action === "remove" &&
          (m as any).ok === true,
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "sandbox_inventory" &&
          Array.isArray((m as any).deleted_instances) &&
          (m as any).deleted_instances.some(
            (d: any) => d?.instance_name === "tuixiu-run-r1" && d?.run_id === "r1",
          ),
      ),
    ).toBe(true);
  });

  it("remove_workspace deletes host workspace in mount mode", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "missing",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => []),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: vi.fn(async () => {
        throw new Error("should not call execProcess");
      }),
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const root = await mkdtemp(path.join(os.tmpdir(), "acp-ws-"));
    const hostWorkspace = path.join(root, "run-r1");
    await mkdir(hostWorkspace, { recursive: true });

    const exists = async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const ctx = {
        cfg: {
          ...baseConfig(),
          sandbox: { ...baseConfig().sandbox, workspaceHostRoot: root, workspaceMode: "mount" },
        },
        sandbox,
        runs: new RunManager(),
        send: (payload: unknown) => messages.push(payload),
        log: () => {},
      };

      await handleSandboxControl(ctx as any, {
        type: "sandbox_control",
        action: "remove_workspace",
        run_id: "r1",
      });

      const result = messages.find(
        (m) => m && typeof m === "object" && (m as any).type === "sandbox_control_result",
      );
      expect(result?.ok).toBe(true);
      expect(await exists(hostWorkspace)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("remove_workspace runs rm -rf /workspace/run-r1 in git_clone mode", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "running",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => []),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: vi.fn(async () => ({
        stdin: new WritableStream<Uint8Array>({ write() {} }),
        stdout: undefined,
        stderr: undefined,
        close: async () => {},
        onExit: (cb: any) => cb({ code: 0, signal: null }),
      })),
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const ctx = {
      cfg: { ...baseConfig(), sandbox: { ...baseConfig().sandbox, workspaceMode: "git_clone" } },
      sandbox,
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    await handleSandboxControl(ctx as any, {
      type: "sandbox_control",
      action: "remove_workspace",
      run_id: "r1",
      instance_name: "tuixiu-run-r1",
    });

    expect(sandbox.execProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceName: "tuixiu-run-r1",
        command: ["bash", "-lc", "rm -rf '/workspace/run-r1'"],
      }),
    );

    const result = messages.find(
      (m) => m && typeof m === "object" && (m as any).type === "sandbox_control_result",
    );
    expect(result?.ok).toBe(true);
  });

  it("prune_orphans removes managed instances not in expected_instances", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "missing",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => [
        { instanceName: "tuixiu-run-a", status: "running", createdAt: null },
        { instanceName: "tuixiu-run-b", status: "running", createdAt: null },
      ]),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const ctx = {
      cfg: baseConfig(),
      sandbox,
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    await handleSandboxControl(ctx as any, {
      type: "sandbox_control",
      action: "prune_orphans",
      proxy_id: "proxy-1",
      expected_instances: [{ instance_name: "tuixiu-run-a", run_id: "a" }],
    });

    expect(sandbox.removeInstance).toHaveBeenCalledWith("tuixiu-run-b");
    expect(
      messages.some(
        (m) =>
          m &&
          typeof m === "object" &&
          (m as any).type === "sandbox_inventory" &&
          Array.isArray((m as any).deleted_instances) &&
          (m as any).deleted_instances.some((d: any) => d?.instance_name === "tuixiu-run-b"),
      ),
    ).toBe(true);
  });

  it("action=gc dry_run plans deletes", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "missing",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => [
        { instanceName: "tuixiu-run-a", status: "running", createdAt: null },
        { instanceName: "tuixiu-run-b", status: "running", createdAt: null },
      ]),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const ctx = {
      cfg: baseConfig(),
      sandbox,
      runs: new RunManager(),
      send: (payload: unknown) => messages.push(payload),
      log: () => {},
    };

    await handleSandboxControl(ctx as any, {
      type: "sandbox_control",
      action: "gc",
      dry_run: true,
      expected_instances: [{ instance_name: "tuixiu-run-a", run_id: "a" }],
    });

    expect(sandbox.removeInstance).not.toHaveBeenCalled();

    const result = messages.find((m) => m && typeof m === "object" && (m as any).type === "sandbox_control_result");
    expect(result?.ok).toBe(true);
    expect(Array.isArray(result?.planned?.deletes)).toBe(true);
  });

  it("action=gc apply removes orphan instance and workspace (mount)", async () => {
    const messages: any[] = [];

    const sandbox: ProxySandbox = {
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName) => ({
        instanceName,
        status: "missing",
        createdAt: null,
      }),
      ensureInstanceRunning: async (opts) => ({
        instanceName: opts.instanceName,
        status: "running",
        createdAt: null,
      }),
      listInstances: vi.fn(async () => [
        { instanceName: "tuixiu-run-a", status: "running", createdAt: null },
        { instanceName: "tuixiu-run-b", status: "running", createdAt: null },
      ]),
      stopInstance: vi.fn(async () => {}),
      removeInstance: vi.fn(async () => {}),
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => {
        throw new Error("not implemented");
      },
    };

    const root = await mkdtemp(path.join(os.tmpdir(), "acp-gc-"));
    const workspaceB = path.join(root, "run-b");
    await mkdir(workspaceB, { recursive: true });

    const exists = async (p: string) => {
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    };

    try {
      const ctx = {
        cfg: { ...baseConfig(), sandbox: { ...baseConfig().sandbox, workspaceHostRoot: root, workspaceMode: "mount" } },
        sandbox,
        runs: new RunManager(),
        send: (payload: unknown) => messages.push(payload),
        log: () => {},
      };

      await handleSandboxControl(ctx as any, {
        type: "sandbox_control",
        action: "gc",
        dry_run: false,
        expected_instances: [{ instance_name: "tuixiu-run-a", run_id: "a" }],
      });

      expect(sandbox.removeInstance).toHaveBeenCalledWith("tuixiu-run-b");
      expect(await exists(workspaceB)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
