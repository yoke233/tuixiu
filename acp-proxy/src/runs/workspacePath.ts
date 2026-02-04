import { WORKSPACE_GUEST_PATH } from "../proxyContext.js";

export function defaultCwdForRun(opts: { workspaceProvider: "host" | "guest"; runId: string }): string {
  return opts.workspaceProvider === "guest"
    ? `${WORKSPACE_GUEST_PATH}/run-${opts.runId}`
    : WORKSPACE_GUEST_PATH;
}
