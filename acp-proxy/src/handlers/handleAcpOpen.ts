import type { ProxyContext } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";
import { ensureRuntime, sendUpdate } from "../runs/runRuntime.js";
import { ensureRunOpen } from "../runs/ensureRunOpen.js";

export async function handleAcpOpen(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;

  try {
    const run = await ensureRuntime(ctx, msg);
    const init = isRecord(msg?.init) ? (msg.init as any) : undefined;
    const initEnv =
      init?.env && typeof init.env === "object" && !Array.isArray(init.env)
        ? (init.env as Record<string, string>)
        : undefined;

    await ctx.runs.enqueue(run.runId, async () => {
      await ensureRunOpen(ctx, run, { init, initEnv });
    });

    ctx.send({ type: "acp_opened", run_id: runId, ok: true });
  } catch (err) {
    const run = ctx.runs.get(runId);
    if (run) {
      // best-effort: nothing to cleanup here; per-run state lives under workspaceHostRoot.
    }
    const errText = err instanceof Error ? err.stack ?? err.message : String(err);
    (ctx.logError ?? ctx.log)("acp_open failed", { runId, err: errText });
    // 即使 open 阶段失败，也把错误写入事件流，方便前端直接看到原因。
    sendUpdate(ctx, runId, {
      type: "text",
      text: `[proxy:error] acp_open failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    ctx.send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
  }
}
