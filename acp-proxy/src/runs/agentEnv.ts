import type { ProxyContext } from "../proxyContext.js";

export function filterAgentInitEnv(
  ctx: ProxyContext,
  runId: string,
  env: Record<string, string>,
): Record<string, string> {
  const allowRaw = Array.isArray(ctx.cfg.agent_env_allowlist) ? ctx.cfg.agent_env_allowlist : [];
  const allow = new Set<string>(allowRaw.map((k) => String(k ?? "").trim()).filter(Boolean));
  allow.add("CODEX_HOME");

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!allow.has(key)) continue;
    out[key] = typeof value === "string" ? value : String(value ?? "");
  }

  try {
    ctx.log("agent env allowlist applied", { runId, keys: Object.keys(out) });
  } catch {
    // ignore
  }

  return out;
}

