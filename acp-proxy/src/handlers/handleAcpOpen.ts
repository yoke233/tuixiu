import type { ProxyContext } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";
import {
  ensureHostWorkspaceGit,
  ensureInitialized,
  ensureRuntime,
  runInitScript,
  startAgent,
} from "../runs/runRuntime.js";
import { cleanupSkillsForRun, prepareSkillsForRun } from "../skills/skillsMount.js";

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
      // reset per-run CODEX_HOME on reopen
      await cleanupSkillsForRun(run).catch(() => {});
      run.skillsCodexHomeHostPath = null;

      if (initEnv) {
        await ensureHostWorkspaceGit(ctx, run, initEnv);
      }

      let initForAgent: any = init;
      const mounted = await prepareSkillsForRun({ ctx, run, init });
      if (mounted) {
        run.skillsCodexHomeHostPath = mounted.codexHomeHostPath;
        const nextEnv = {
          ...(initEnv ? { ...initEnv } : {}),
          CODEX_HOME: mounted.codexHomeGuestPath,
        };
        initForAgent = { ...(initForAgent ?? {}), env: nextEnv };
      } else {
        // ensure no stale CODEX_HOME from previous runs
        if (initEnv && "CODEX_HOME" in initEnv) {
          const nextEnv = { ...initEnv };
          delete (nextEnv as any).CODEX_HOME;
          initForAgent = { ...(initForAgent ?? {}), env: nextEnv };
        }
      }

      if (ctx.sandbox.agentMode === "exec") {
        const initOk = await runInitScript(ctx, run, initForAgent);
        if (!initOk) throw new Error("init_failed");
        await startAgent(ctx, run, initForAgent);
      } else {
        await startAgent(ctx, run, initForAgent);
      }

      await ensureInitialized(ctx, run);
    });

    ctx.send({ type: "acp_opened", run_id: runId, ok: true });
  } catch (err) {
    const run = ctx.runs.get(runId);
    if (run) {
      await cleanupSkillsForRun(run).catch(() => {});
      run.skillsCodexHomeHostPath = null;
    }
    ctx.send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
  }
}
