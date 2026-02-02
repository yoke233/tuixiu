import type { AgentInputsManifestV1 } from "./agentInputsSchema.js";
import { agentInputsManifestV1Schema } from "./agentInputsSchema.js";

export function mergeAgentInputsManifests(
  base: AgentInputsManifestV1,
  extraRaw: unknown,
): AgentInputsManifestV1 {
  if (extraRaw == null) return base;
  const extra = agentInputsManifestV1Schema.parse(extraRaw);

  const envPatch =
    base.envPatch || extra.envPatch ? { ...(base.envPatch ?? {}), ...(extra.envPatch ?? {}) } : undefined;

  return {
    version: 1,
    ...(envPatch ? { envPatch } : {}),
    items: [...base.items, ...extra.items],
  };
}

