export function resolveAgentWorkspaceCwd(opts: {
  runId: string;
  sandboxWorkspaceProvider?: string | null;
}): string {
  const runId = String(opts.runId ?? "").trim();
  if (!runId) return "/workspace";
  return opts.sandboxWorkspaceProvider === "guest" ? `/workspace/run-${runId}` : "/workspace";
}
