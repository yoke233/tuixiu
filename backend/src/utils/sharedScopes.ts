export const SHARED_SCOPE_PROJECT = "project";
export const SHARED_SCOPE_PLATFORM = "platform";

export type SharedScope = typeof SHARED_SCOPE_PROJECT | typeof SHARED_SCOPE_PLATFORM;

export function normalizeSharedScope(value: unknown): SharedScope {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === SHARED_SCOPE_PLATFORM ? SHARED_SCOPE_PLATFORM : SHARED_SCOPE_PROJECT;
}

export function isPlatformScope(value: unknown): boolean {
  return normalizeSharedScope(value) === SHARED_SCOPE_PLATFORM;
}

export function isProjectScope(value: unknown): boolean {
  return normalizeSharedScope(value) === SHARED_SCOPE_PROJECT;
}
