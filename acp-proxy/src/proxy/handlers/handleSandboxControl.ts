import { randomUUID } from "node:crypto";

import type { ProxyContext } from "../proxyContext.js";
import { WORKSPACE_GUEST_PATH, nowIso } from "../proxyContext.js";
import { closeAgent, sendSandboxInstanceStatus } from "../runs/runRuntime.js";
import { validateInstanceName, validateRunId } from "../utils/validate.js";

async function reportInventory(ctx: ProxyContext): Promise<void> {
  const capturedAt = nowIso();
  const inventoryId = randomUUID();
  const instances = await ctx.sandbox.listInstances({ managedOnly: true });
  ctx.send({
    type: "sandbox_inventory",
    inventory_id: inventoryId,
    provider: ctx.sandbox.provider,
    runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
    captured_at: capturedAt,
    instances: instances.map((i) => {
      const runId = i.instanceName.startsWith("tuixiu-run-")
        ? i.instanceName.slice("tuixiu-run-".length)
        : null;
      return {
        instance_name: i.instanceName,
        run_id: runId,
        status: i.status,
        created_at: i.createdAt,
        last_seen_at: capturedAt,
      };
    }),
  });
}

export async function handleSandboxControl(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  const instanceNameRaw = String(msg?.instance_name ?? "").trim();
  const action = String(msg?.action ?? "").trim();

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "sandbox_control_result",
        run_id: runId || null,
        instance_name: instanceNameRaw || null,
        action,
        ...payload,
      });
    } catch (err) {
      ctx.log("failed to send sandbox_control_result", { err: String(err) });
    }
  };

  try {
    if (action === "report_inventory") {
      await reportInventory(ctx);
      reply({ ok: true });
      return;
    }

    const instanceName = validateInstanceName(instanceNameRaw);

    if (action === "inspect") {
      const info = await ctx.sandbox.inspectInstance(instanceName);
      if (runId) {
        sendSandboxInstanceStatus(ctx, {
          runId,
          instanceName,
          status: info.status === "missing" ? "missing" : info.status,
          lastError: null,
        });
      }
      reply({ ok: true, status: info.status, details: { created_at: info.createdAt } });
      return;
    }

    if (action === "ensure_running") {
      const effectiveRunId = validateRunId(runId);
      const info = await ctx.sandbox.ensureInstanceRunning({
        runId: effectiveRunId,
        instanceName,
        workspaceGuestPath: WORKSPACE_GUEST_PATH,
        env: undefined,
      });
      sendSandboxInstanceStatus(ctx, {
        runId: effectiveRunId,
        instanceName,
        status: info.status === "missing" ? "missing" : info.status,
        lastError: null,
      });
      reply({ ok: true, status: info.status, details: { created_at: info.createdAt } });
      return;
    }

    if (action === "stop") {
      if (runId) {
        const run = ctx.runs.get(runId);
        if (run) await closeAgent(ctx, run, "sandbox_control_stop");
      }
      await ctx.sandbox.stopInstance(instanceName);
      const info = await ctx.sandbox.inspectInstance(instanceName);
      if (runId) {
        sendSandboxInstanceStatus(ctx, {
          runId,
          instanceName,
          status: info.status === "missing" ? "missing" : info.status,
          lastError: null,
        });
      }
      reply({ ok: true, status: info.status });
      return;
    }

    if (action === "remove") {
      if (runId) {
        const run = ctx.runs.get(runId);
        if (run) await closeAgent(ctx, run, "sandbox_control_remove");
        ctx.runs.delete(runId);
      }
      await ctx.sandbox.removeInstance(instanceName);
      if (runId) {
        sendSandboxInstanceStatus(ctx, {
          runId,
          instanceName,
          status: "missing",
          lastError: null,
        });
      }
      reply({ ok: true, status: "missing" });
      return;
    }

    reply({ ok: false, error: "unsupported_action" });
  } catch (err) {
    const message = String(err);
    if (runId && instanceNameRaw) {
      sendSandboxInstanceStatus(ctx, {
        runId,
        instanceName: instanceNameRaw,
        status: "error",
        lastError: message,
      });
    }
    reply({ ok: false, error: message });
  }
}
