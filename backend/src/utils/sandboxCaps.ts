function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type SandboxWorkspaceProvider = "host" | "guest";
export type SandboxGitPushMode = "supported" | "unsupported";

export function getSandboxWorkspaceProvider(caps: unknown): SandboxWorkspaceProvider | null {
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  const raw = String((sandbox as any).workspaceProvider ?? "").trim();
  if (raw === "guest") return "guest";
  if (raw === "host") return "host";
  return null;
}

export function isSandboxWorkspaceGuest(caps: unknown): boolean {
  return getSandboxWorkspaceProvider(caps) === "guest";
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
