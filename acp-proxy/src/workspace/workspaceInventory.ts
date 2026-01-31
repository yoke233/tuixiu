import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { ProxyContext } from "../proxyContext.js";
import { nowIso } from "../proxyContext.js";

type WorkspaceInventoryItem = {
  workspace_mode: "mount" | "git_clone";
  run_id: string | null;
  instance_name: string | null;
  host_path: string | null;
  guest_path: string | null;
  exists: boolean | null;
  mtime: string | null;
  size_bytes: number | null;
};

export async function reportWorkspaceInventory(ctx: ProxyContext): Promise<void> {
  const capturedAt = nowIso();
  const inventoryId = randomUUID();
  const workspaceMode = (ctx.cfg.sandbox.workspaceMode ?? "mount") === "git_clone" ? "git_clone" : "mount";

  const workspaces: WorkspaceInventoryItem[] = [];

  if (workspaceMode === "mount") {
    const rootRaw = ctx.cfg.sandbox.workspaceHostRoot?.trim() ?? "";
    if (rootRaw) {
      const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
      const resolvedRoot = path.resolve(root);
      const entries = await readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);

      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (!ent.name.startsWith("run-")) continue;
        const runId = ent.name.slice("run-".length) || null;
        const hostPath = path.join(resolvedRoot, ent.name);
        const mtime = await stat(hostPath)
          .then((s) => s.mtime.toISOString())
          .catch(() => null);
        workspaces.push({
          workspace_mode: "mount",
          run_id: runId,
          instance_name: null,
          host_path: hostPath,
          guest_path: null,
          exists: true,
          mtime,
          size_bytes: null,
        });
      }
    }
  }

  if (workspaceMode === "git_clone") {
    const instances = await ctx.sandbox.listInstances({ managedOnly: true }).catch(() => []);
    for (const inst of instances) {
      const runId = inst.instanceName.startsWith("tuixiu-run-")
        ? inst.instanceName.slice("tuixiu-run-".length)
        : null;
      if (!runId) continue;
      workspaces.push({
        workspace_mode: "git_clone",
        run_id: runId,
        instance_name: inst.instanceName,
        host_path: null,
        guest_path: `/workspace/run-${runId}`,
        exists: null,
        mtime: null,
        size_bytes: null,
      });
    }
  }

  ctx.send({
    type: "workspace_inventory",
    inventory_id: inventoryId,
    captured_at: capturedAt,
    workspace_mode: workspaceMode,
    workspaces,
  });
}

