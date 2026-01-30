import type { ProxyContext } from "../proxyContext.js";

export async function handleSessionPermission(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;

  const requestId = msg?.request_id ?? null;
  if (requestId == null || String(requestId).trim() === "") {
    ctx.log("session_permission missing request_id", { runId });
    return;
  }

  const run = ctx.runs.get(runId);
  if (!run || !run.acpClient) {
    ctx.log("session_permission run not ready", { runId, requestId: String(requestId) });
    return;
  }

  const outcomeRaw = String(msg?.outcome ?? "").trim().toLowerCase();
  let ok = false;
  if (outcomeRaw === "selected") {
    const optionId = String(msg?.option_id ?? "").trim();
    ok = run.acpClient.resolvePermission(requestId, { outcome: "selected", optionId });
  } else {
    ok = run.acpClient.cancelPermissionRequest(requestId);
  }

  if (!ok) {
    ctx.log("session_permission not matched", { runId, requestId: String(requestId) });
  }
}
