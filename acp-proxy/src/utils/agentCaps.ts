function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

export function getToolSet(capabilities: unknown): Set<string> {
  if (!isRecord(capabilities)) return new Set();
  const tools = (capabilities as any).tools;
  if (!Array.isArray(tools)) return new Set();
  const out = new Set<string>();
  for (const item of tools) {
    if (typeof item !== "string") continue;
    const name = normalizeToolName(item);
    if (name) out.add(name);
  }
  return out;
}

export function hasAgentTool(capabilities: unknown, tool: string): boolean {
  const target = normalizeToolName(tool);
  if (!target) return false;
  return getToolSet(capabilities).has(target);
}

export function isTerminalToolEnabled(opts: {
  sandboxTerminalEnabled: boolean;
  capabilities: unknown;
}): boolean {
  if (!opts.sandboxTerminalEnabled) return false;
  return hasAgentTool(opts.capabilities, "terminal");
}

export function isFsToolEnabled(capabilities: unknown): boolean {
  return hasAgentTool(capabilities, "fs");
}

export function isGitToolEnabled(capabilities: unknown): boolean {
  return hasAgentTool(capabilities, "git");
}

export function isTerminalCommandAllowed(capabilities: unknown, command: string): boolean {
  const cmd = normalizeToolName(command);
  if (!cmd) return false;
  return getToolSet(capabilities).has(cmd);
}
