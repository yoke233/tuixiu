import type { WorkspacePolicy } from "./workspacePolicy.js";

export type InitActionType =
  | "ensure_workspace"
  | "init_repo"
  | "init_bundle"
  | "write_inventory";

export type InitAction = {
  type: InitActionType;
  params?: Record<string, unknown>;
};

export type InitPipeline = {
  actions: InitAction[];
};

export function buildInitPipeline(opts: {
  policy: WorkspacePolicy;
  hasBundle: boolean;
}): InitPipeline {
  const actions: InitAction[] = [{ type: "ensure_workspace" }];
  if (opts.policy === "git") actions.push({ type: "init_repo" });
  if (opts.policy === "bundle" || opts.hasBundle) actions.push({ type: "init_bundle" });
  actions.push({ type: "write_inventory" });
  return { actions };
}
