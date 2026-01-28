export const DEFAULT_SANDBOX_KEEPALIVE_TTL_SECONDS = 1800;

export function deriveSandboxInstanceName(runId: string): string {
  return `tuixiu-run-${String(runId ?? "").trim()}`;
}

export function normalizeKeepaliveTtlSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

