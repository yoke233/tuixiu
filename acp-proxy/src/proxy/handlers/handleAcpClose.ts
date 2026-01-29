import type { ProxyContext } from "../proxyContext.js";
import { closeAgent } from "../runs/runRuntime.js";

export async function handleAcpClose(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;

  const run = ctx.runs.get(runId);
  if (!run) return;

  await closeAgent(ctx, run, "requested");
  run.expiresAt = Date.now() + run.keepaliveTtlSeconds * 1000;

  try {
    ctx.send({ type: "acp_closed", run_id: runId, ok: true });
  } catch {
    // ignore
  }
}
