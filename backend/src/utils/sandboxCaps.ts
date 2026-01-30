function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type SandboxWorkspaceMode = "mount" | "git_clone";
export type SandboxGitPushMode = "supported" | "unsupported";

export function getSandboxWorkspaceMode(caps: unknown): SandboxWorkspaceMode | null {
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  const raw = String((sandbox as any).workspaceMode ?? "").trim();
  if (raw === "git_clone") return "git_clone";
  if (raw === "mount") return "mount";
  return null;
}

export function isSandboxGitClone(caps: unknown): boolean {
  return getSandboxWorkspaceMode(caps) === "git_clone";
}

export function getSandboxGitPushMode(caps: unknown): SandboxGitPushMode | null {
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  const raw = (sandbox as any).gitPush;
  if (raw === true) return "supported";
  if (raw === false) return "unsupported";
  return null;
}

export function isSandboxGitPushEnabled(caps: unknown): boolean {
  return getSandboxGitPushMode(caps) === "supported";
}
