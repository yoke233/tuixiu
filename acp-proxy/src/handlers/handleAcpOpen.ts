import type { ProxyContext } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";
import {
  ensureHostWorkspaceGit,
  ensureInitialized,
  ensureRuntime,
  runInitScript,
  startAgent,
} from "../runs/runRuntime.js";

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
      if (initEnv) {
        await ensureHostWorkspaceGit(ctx, run, initEnv);
      }
      if (ctx.sandbox.agentMode === "exec") {
        const initOk = await runInitScript(ctx, run, init);
        if (!initOk) throw new Error("init_failed");
        await startAgent(ctx, run);
      } else {
        await startAgent(ctx, run, init);
      }

      await ensureInitialized(ctx, run);
    });

    ctx.send({ type: "acp_opened", run_id: runId, ok: true });
  } catch (err) {
    ctx.send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
  }
}
