import type { ProxyContext } from "../proxyContext.js";
import { ensureInitialized, withAuthRetry } from "../runs/runRuntime.js";

export async function handleSessionCancel(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;
  const controlIdRaw = String(msg?.control_id ?? "").trim();
  const sessionId = String(msg?.session_id ?? "").trim();

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "session_control_result",
        run_id: runId,
        control_id: controlIdRaw,
        ...payload,
      });
    } catch (err) {
      ctx.log("failed to send session_control_result", { runId, err: String(err) });
    }
  };

  try {
    if (!controlIdRaw) {
      reply({ ok: false, error: "control_id 为空" });
      return;
    }
    if (!sessionId) {
      reply({ ok: false, error: "session_id 为空" });
      return;
    }

    const run = ctx.runs.get(runId);
    if (!run || !run.agent) {
      reply({ ok: false, error: "run_not_open" });
      return;
    }

    await run.agent.sendNotification("session/cancel", { sessionId });
    reply({ ok: true });
  } catch (err) {
    reply({ ok: false, error: String(err) });
  }
}

export async function handleSessionSetMode(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;
  const controlIdRaw = String(msg?.control_id ?? "").trim();
  const sessionId = String(msg?.session_id ?? "").trim();
  const modeId = String(msg?.mode_id ?? "").trim();

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "session_control_result",
        run_id: runId,
        control_id: controlIdRaw,
        ...payload,
      });
    } catch (err) {
      ctx.log("failed to send session_control_result", { runId, err: String(err) });
    }
  };

  try {
    if (!controlIdRaw) {
      reply({ ok: false, error: "control_id 为空" });
      return;
    }
    if (!sessionId) {
      reply({ ok: false, error: "session_id 为空" });
      return;
    }
    if (!modeId) {
      reply({ ok: false, error: "mode_id 为空" });
      return;
    }

    const run = ctx.runs.get(runId);
    if (!run || !run.agent) {
      reply({ ok: false, error: "run_not_open" });
      return;
    }

    await ensureInitialized(ctx, run);
    await withAuthRetry(run, () => run.agent!.sendRpc("session/set_mode", { sessionId, modeId }));
    reply({ ok: true });
  } catch (err) {
    reply({ ok: false, error: String(err) });
  }
}

export async function handleSessionSetModel(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;
  const controlIdRaw = String(msg?.control_id ?? "").trim();
  const sessionId = String(msg?.session_id ?? "").trim();
  const modelId = String(msg?.model_id ?? "").trim();

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "session_control_result",
        run_id: runId,
        control_id: controlIdRaw,
        ...payload,
      });
    } catch (err) {
      ctx.log("failed to send session_control_result", { runId, err: String(err) });
    }
  };

  try {
    if (!controlIdRaw) {
      reply({ ok: false, error: "control_id 为空" });
      return;
    }
    if (!sessionId) {
      reply({ ok: false, error: "session_id 为空" });
      return;
    }
    if (!modelId) {
      reply({ ok: false, error: "model_id 为空" });
      return;
    }

    const run = ctx.runs.get(runId);
    if (!run || !run.agent) {
      reply({ ok: false, error: "run_not_open" });
      return;
    }

    await ensureInitialized(ctx, run);
    await withAuthRetry(run, () => run.agent!.sendRpc("session/set_model", { sessionId, modelId }));
    reply({ ok: true });
  } catch (err) {
    reply({ ok: false, error: String(err) });
  }
}
