import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { RunManager } from "./runManager.js";
import { ensureRuntime } from "./runRuntime.js";

describe("runs/ensureRuntime mounts", () => {
  it("adds per-run /root mount when enabled", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-ensureRuntime-"));
    try {
      const ensureInstanceRunning = vi.fn(async () => {
        return { instanceName: "tuixiu-run-r1", status: "running", createdAt: null };
      });

      const ctx = {
        cfg: {
          sandbox: {
            provider: "bwrap",
            terminalEnabled: false,
            workspaceProvider: "host",
            workspaceHostRoot: rootDir,
            perRunRootEnabled: true,
            perRunRootGuestPath: "/root",
            perRunRootHostSubdir: ".tuixiu/root",
          },
        },
        sandbox: {
          provider: "bwrap",
          runtime: null,
          agentMode: "exec",
          inspectInstance: vi.fn(async () => ({ instanceName: "tuixiu-run-r1", status: "missing", createdAt: null })),
          ensureInstanceRunning,
        },
        platform: {} as any,
        runs: new RunManager(),
        send: () => {},
        log: () => {},
      } as any;

      const run = await ensureRuntime(ctx, { type: "acp_open", run_id: "r1" });
      expect(run.workspaceMounts).toBeTruthy();

      const mounts = run.workspaceMounts as Array<{ hostPath: string; guestPath: string }>;
      expect(mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ guestPath: "/workspace" }),
          expect.objectContaining({ guestPath: "/root" }),
        ]),
      );

      const rootMount = mounts.find((m) => m.guestPath === "/root")!;
      expect(rootMount.hostPath).toBe(path.join(rootDir, "home-r1"));
      await expect(fs.stat(path.join(rootMount.hostPath, ".codex"))).resolves.toBeTruthy();

      expect(ensureInstanceRunning).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "r1",
          instanceName: "tuixiu-run-r1",
          mounts: expect.arrayContaining([
            expect.objectContaining({ guestPath: "/root" }),
          ]),
        }),
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("uses agentInputs WORKSPACE bindMount hostPath when provided (no TUIXIU_WORKSPACE required)", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-ensureRuntime-"));
    try {
      const ensureInstanceRunning = vi.fn(async () => {
        return { instanceName: "tuixiu-run-r1", status: "running", createdAt: null };
      });

      const workspaceHostPath = path.join(rootDir, "custom", "ws");

      const ctx = {
        cfg: {
          sandbox: {
            provider: "bwrap",
            terminalEnabled: false,
            workspaceProvider: "host",
            workspaceHostRoot: rootDir,
          },
        },
        sandbox: {
          provider: "bwrap",
          runtime: null,
          agentMode: "exec",
          inspectInstance: vi.fn(async () => ({ instanceName: "tuixiu-run-r1", status: "missing", createdAt: null })),
          ensureInstanceRunning,
        },
        platform: {} as any,
        runs: new RunManager(),
        send: () => {},
        log: () => {},
      } as any;

      const run = await ensureRuntime(ctx, {
        type: "acp_open",
        run_id: "r1",
        init: {
          env: {},
          agentInputs: {
            version: 1,
            items: [
              {
                id: "workspace",
                apply: "bindMount",
                access: "rw",
                source: { type: "hostPath", path: workspaceHostPath },
                target: { root: "WORKSPACE", path: "." },
              },
            ],
          },
        },
      });

      expect(run.hostWorkspacePath).toBe(path.resolve(workspaceHostPath));

      const mounts = run.workspaceMounts as Array<{ hostPath: string; guestPath: string }>;
      const workspaceMount = mounts.find((m) => m.guestPath === "/workspace")!;
      expect(workspaceMount.hostPath).toBe(path.resolve(workspaceHostPath));

      expect(ensureInstanceRunning).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "r1",
          instanceName: "tuixiu-run-r1",
          mounts: expect.arrayContaining([
            expect.objectContaining({ guestPath: "/workspace", hostPath: path.resolve(workspaceHostPath) }),
          ]),
        }),
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects USER_HOME=/workspace to avoid mount conflicts", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-ensureRuntime-"));
    try {
      const ensureInstanceRunning = vi.fn(async () => {
        return { instanceName: "tuixiu-run-r1", status: "running", createdAt: null };
      });

      const ctx = {
        cfg: {
          sandbox: {
            provider: "bwrap",
            terminalEnabled: false,
            workspaceProvider: "host",
            workspaceHostRoot: rootDir,
          },
        },
        sandbox: {
          provider: "bwrap",
          runtime: null,
          agentMode: "exec",
          inspectInstance: vi.fn(async () => ({ instanceName: "tuixiu-run-r1", status: "missing", createdAt: null })),
          ensureInstanceRunning,
        },
        platform: {} as any,
        runs: new RunManager(),
        send: () => {},
        log: () => {},
      } as any;

      await expect(
        ensureRuntime(ctx, {
          type: "acp_open",
          run_id: "r1",
          init: {
            env: { USER_HOME: "/workspace" },
            agentInputs: { version: 1, items: [] },
          },
        }),
      ).rejects.toThrow(/USER_HOME\/HOME must not be \/workspace/i);
      expect(ensureInstanceRunning).not.toHaveBeenCalled();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
