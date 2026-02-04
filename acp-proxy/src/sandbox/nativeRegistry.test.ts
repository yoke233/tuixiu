import { describe, expect, it } from "vitest";

import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HostProcessProxySandbox } from "./hostProcessProxySandbox.js";

describe("sandbox/nativeRegistry", () => {
  it("openAgent writes registry and listInstances can recover", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "acp-native-registry-"));
    const cfg = {
      terminalEnabled: false,
      provider: "host_process",
      workspaceProvider: "host",
      workspaceHostRoot: root,
      volumes: [],
      env: {},
    } as any;

    const log = () => {};

    const sandbox = new HostProcessProxySandbox({ config: cfg, log });

    try {
      await sandbox.ensureInstanceRunning({
        runId: "r1",
        instanceName: "tuixiu-run-r1",
        workspaceGuestPath: "/workspace",
        env: undefined,
      });

      const res = await sandbox.openAgent({
        runId: "r1",
        instanceName: "tuixiu-run-r1",
        workspaceGuestPath: "/workspace",
        agentCommand: ["node", "-e", "console.log('ok')"],
      });
      expect(res.created).toBe(true);

      // pid may not be exposed by ProcessHandle; use best-effort liveness check via registry.
      const sandbox2 = new HostProcessProxySandbox({ config: cfg, log });
      const list = await sandbox2.listInstances();

      expect(list.some((i) => i.instanceName === "tuixiu-run-r1")).toBe(true);

      const registryPath = path.join(root, ".acp-proxy", "registry.json");
      await access(registryPath);
    } finally {
      await sandbox.removeInstance("tuixiu-run-r1").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 60));
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
