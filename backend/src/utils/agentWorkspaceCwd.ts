export function resolveAgentWorkspaceCwd(opts: {
  runId: string;
  sandboxWorkspaceMode?: string | null;
}): string {
  const runId = String(opts.runId ?? "").trim();
  if (!runId) return "/workspace";
  return opts.sandboxWorkspaceMode === "git_clone" ? `/workspace/run-${runId}` : "/workspace";
}

