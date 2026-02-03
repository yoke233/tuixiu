import type { ProxyContext } from "../proxyContext.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";

import type { RunRuntime } from "./runTypes.js";
import { parseAgentInputsFromInit } from "./agentInputs.js";
import { applyAgentInputs } from "./applyAgentInputs.js";
import {
  ensureHostWorkspaceGit,
  ensureInitialized,
  runInitScript,
  startAgent,
} from "./runRuntime.js";

export async function ensureRunOpen(
  ctx: ProxyContext,
  run: RunRuntime,
  opts: { init?: AgentInit & { agentInputs?: unknown }; initEnv?: Record<string, string> },
): Promise<void> {
  if (run.agent && run.initialized) return;
  if (run.agent) {
    await ensureInitialized(ctx, run);
    return;
  }

  const init = opts.init;
  const initEnv = opts.initEnv;
  const manifest = parseAgentInputsFromInit(init);
  if (!manifest) throw new Error("init.agentInputs missing");

  const nextEnv = initEnv ? { ...initEnv } : {};

  // 统一 home 语义：USER_HOME（沙盒内 ~）为权威；若缺失则回填为 ensureRuntime 解析结果。
  const userHomeGuestPath = run.userHomeGuestPath?.trim() ?? "";
  if (userHomeGuestPath) {
    if (!String(nextEnv.USER_HOME ?? "").trim()) nextEnv.USER_HOME = userHomeGuestPath;
    if (!String(nextEnv.HOME ?? "").trim()) nextEnv.HOME = userHomeGuestPath;
  }

  // 允许 agentInputs.envPatch 仅覆盖 HOME/USER/LOGNAME（parseAgentInputsFromInit 已校验键集合）
  if (manifest.envPatch) {
    for (const [k, v] of Object.entries(manifest.envPatch)) {
      if (typeof v === "string") nextEnv[k] = v;
    }
  }

  // 可选：如果需要 git workspace，先准备 host git（保持与现行为一致）
  if (String(nextEnv.TUIXIU_REPO_URL ?? "").trim()) {
    await ensureHostWorkspaceGit(ctx, run, nextEnv);
  }

  await applyAgentInputs({ ctx, run, manifest });

  const initForAgent: AgentInit | undefined = init ? ({ ...init, env: nextEnv } as AgentInit) : undefined;

  if (ctx.sandbox.agentMode === "exec") {
    const ok = await runInitScript(ctx, run, initForAgent);
    if (!ok) throw new Error("init_failed");
  }

  await startAgent(ctx, run, initForAgent);
  await ensureInitialized(ctx, run);
}

