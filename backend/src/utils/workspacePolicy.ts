import { getSandboxWorkspaceMode } from "./sandboxCaps.js";

export const WORKSPACE_POLICIES = ["git", "mount", "empty", "bundle"] as const;
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number];

export type WorkspacePolicySource = {
  resolved: WorkspacePolicy;
  source: "task" | "role" | "project" | "profile" | "platform";
  chain: {
    task?: WorkspacePolicy | null;
    role?: WorkspacePolicy | null;
    project?: WorkspacePolicy | null;
    profile?: WorkspacePolicy | null;
    platform?: WorkspacePolicy | null;
  };
};

export function normalizeWorkspacePolicy(value: unknown): WorkspacePolicy | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "git" || raw === "mount" || raw === "empty" || raw === "bundle") return raw;
  return null;
}

export function resolveWorkspacePolicy(opts: {
  platformDefault?: unknown;
  projectPolicy?: unknown;
  rolePolicy?: unknown;
  taskPolicy?: unknown;
  profilePolicy?: unknown;
}): WorkspacePolicySource {
  const chain = {
    task: normalizeWorkspacePolicy(opts.taskPolicy),
    role: normalizeWorkspacePolicy(opts.rolePolicy),
    project: normalizeWorkspacePolicy(opts.projectPolicy),
    profile: normalizeWorkspacePolicy(opts.profilePolicy),
    platform: normalizeWorkspacePolicy(opts.platformDefault),
  };

  if (chain.task) return { resolved: chain.task, source: "task", chain };
  if (chain.role) return { resolved: chain.role, source: "role", chain };
  if (chain.project) return { resolved: chain.project, source: "project", chain };
  if (chain.profile) return { resolved: chain.profile, source: "profile", chain };
  if (chain.platform) return { resolved: chain.platform, source: "platform", chain };
  return { resolved: "git", source: "platform", chain };
}

export function assertWorkspacePolicyCompat(opts: {
  policy: WorkspacePolicy;
  capabilities: unknown;
}) {
  const mode = getSandboxWorkspaceMode(opts.capabilities);
  if (!mode) return;
  if (opts.policy === "mount" && mode !== "mount") {
    throw new Error("Agent 不支持 mount workspace 模式");
  }
  if (opts.policy === "git" && mode !== "git_clone") {
    throw new Error("Agent 不支持 git workspace 模式");
  }
}
