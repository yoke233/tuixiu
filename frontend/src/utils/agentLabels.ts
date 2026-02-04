import type { Agent } from "@/types";

type SandboxLabel = { label: string; details?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function platformLabel(platform: string | null): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform ? platform : "未知";
  }
}

export function getAgentEnvLabel(agent: Agent | null): string | null {
  if (!agent) return null;
  const caps = isRecord(agent.capabilities) ? agent.capabilities : null;
  const runtime = caps && isRecord(caps.runtime) ? caps.runtime : null;
  const platform = runtime && typeof runtime.platform === "string" ? runtime.platform : null;
  const isWsl = runtime && typeof runtime.isWsl === "boolean" ? runtime.isWsl : null;
  if (isWsl) return "WSL2";
  return platformLabel(platform);
}

export function getAgentSandboxLabel(agent: Agent | null): SandboxLabel | null {
  if (!agent) return null;
  const caps = isRecord(agent.capabilities) ? agent.capabilities : null;
  const sandbox = caps && isRecord(caps.sandbox) ? caps.sandbox : null;
  const provider = sandbox && typeof sandbox.provider === "string" ? sandbox.provider : null;
  if (!provider) return null;

  if (provider === "boxlite_oci" && sandbox) {
    const boxlite = isRecord(sandbox.boxlite) ? sandbox.boxlite : null;
    const image = boxlite && typeof boxlite.image === "string" ? boxlite.image : "";
    return { label: "boxlite_oci", details: image || undefined };
  }

  return { label: provider };
}

