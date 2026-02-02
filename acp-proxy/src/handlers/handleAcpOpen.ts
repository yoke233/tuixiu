import type { ProxyContext } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";
import {
  ensureHostWorkspaceGit,
  ensureInitialized,
  ensureRuntime,
  runInitScript,
  startAgent,
} from "../runs/runRuntime.js";
import { parseAgentInputsFromInit } from "../runs/agentInputs.js";
import { applyAgentInputs } from "../runs/applyAgentInputs.js";

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
    const agentInputs = parseAgentInputsFromInit(init) ?? { version: 1, items: [] };
    if (!("agentInputs" in (init ?? {}))) {
      ctx.log("acp_open missing agentInputs; using empty manifest for backward compatibility", { runId });
    }

    await ctx.runs.enqueue(run.runId, async () => {
      const nextEnv = initEnv ? { ...initEnv } : {};

      // 统一 home 语义：USER_HOME（沙盒内 ~）为权威；若缺失则回填为 ensureRuntime 解析结果。
      const userHomeGuestPath = run.userHomeGuestPath?.trim() ?? "";
      if (userHomeGuestPath) {
        if (!String(nextEnv.USER_HOME ?? "").trim()) nextEnv.USER_HOME = userHomeGuestPath;
        if (!String(nextEnv.HOME ?? "").trim()) nextEnv.HOME = userHomeGuestPath;
      }

      // 允许 agentInputs.envPatch 仅覆盖 HOME/USER/LOGNAME（parseAgentInputsFromInit 已校验键集合）
      if (agentInputs.envPatch) {
        for (const [k, v] of Object.entries(agentInputs.envPatch)) {
          if (typeof v === "string") nextEnv[k] = v;
        }
      }

      if (String(nextEnv.TUIXIU_REPO_URL ?? "").trim()) {
        await ensureHostWorkspaceGit(ctx, run, nextEnv);
      }

      await applyAgentInputs({ ctx, run, manifest: agentInputs });

      const initForAgent: any = { ...(init ?? {}), env: nextEnv };

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
      // best-effort: nothing to cleanup here; per-run state lives under workspaceHostRoot.
    }
    ctx.send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
  }
}
