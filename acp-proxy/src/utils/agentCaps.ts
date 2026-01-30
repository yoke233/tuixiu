function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hasAgentTool(capabilities: unknown, tool: string): boolean {
  if (!isRecord(capabilities)) return false;
  const tools = (capabilities as any).tools;
  if (!Array.isArray(tools)) return false;
  const target = tool.trim();
  if (!target) return false;
  return tools.some((t) => typeof t === "string" && t.trim() === target);
}

export function isTerminalToolEnabled(opts: {
  sandboxTerminalEnabled: boolean;
  capabilities: unknown;
}): boolean {
  if (!opts.sandboxTerminalEnabled) return false;
  return hasAgentTool(opts.capabilities, "terminal");
}
