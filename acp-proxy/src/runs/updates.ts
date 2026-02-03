import type { ProxyContext } from "../proxyContext.js";
import { nowIso } from "../proxyContext.js";

export function sendUpdate(ctx: ProxyContext, runId: string, content: unknown): void {
  try {
    ctx.send({ type: "proxy_update", run_id: runId, content });
  } catch (err) {
    ctx.log("failed to send proxy_update", { runId, err: String(err) });
  }
}

export function reportProxyError(ctx: ProxyContext, runId: string, message: string): void {
  sendUpdate(ctx, runId, { type: "text", text: `[proxy:error] ${message}` });
}

export function sendSandboxInstanceStatus(
  ctx: ProxyContext,
  opts: {
    runId: string;
    instanceName: string;
    status: "creating" | "running" | "stopped" | "missing" | "error";
    lastError?: string | null;
  },
): void {
  sendUpdate(ctx, opts.runId, {
    type: "sandbox_instance_status",
    instance_name: opts.instanceName,
    provider: ctx.sandbox.provider,
    runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
    status: opts.status,
    last_seen_at: nowIso(),
    last_error: opts.lastError ?? null,
  });
}

