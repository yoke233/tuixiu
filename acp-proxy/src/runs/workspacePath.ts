import { WORKSPACE_GUEST_PATH } from "../proxyContext.js";

export function defaultCwdForRun(opts: { workspaceMode: "mount" | "git_clone"; runId: string }): string {
  return opts.workspaceMode === "git_clone"
    ? `${WORKSPACE_GUEST_PATH}/run-${opts.runId}`
    : WORKSPACE_GUEST_PATH;
}

