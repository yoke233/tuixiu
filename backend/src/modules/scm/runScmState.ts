import type { PrismaDeps } from "../../db.js";

export type ScmProvider = "github" | "gitlab";
export type ScmPrState = "open" | "closed" | "merged";
export type ScmCiStatus = "pending" | "passed" | "failed";

export type RunScmStatePatch = {
  scmProvider?: ScmProvider | null;
  scmHeadSha?: string | null;
  scmPrNumber?: number | null;
  scmPrUrl?: string | null;
  scmPrState?: ScmPrState | null;
  scmCiStatus?: ScmCiStatus | null;
  scmUpdatedAt?: Date | null;
};

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeOptionalInt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function normalizeScmProvider(value: unknown): ScmProvider | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "github" || v === "gitlab") return v;
  return null;
}

function normalizeScmPrState(value: unknown): ScmPrState | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === "open" || v === "opened") return "open";
  if (v === "closed") return "closed";
  if (v === "merged" || v === "merge") return "merged";
  return null;
}

function normalizeScmCiStatus(value: unknown): ScmCiStatus | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value === "boolean") return value ? "passed" : "failed";

  const v = String(value).trim().toLowerCase();
  if (!v) return null;

  if (v === "passed" || v === "pass" || v === "success" || v === "succeeded") return "passed";
  if (v === "failed" || v === "fail" || v === "failure" || v === "cancelled" || v === "canceled" || v === "timed_out")
    return "failed";
  if (v === "pending" || v === "in_progress" || v === "queued" || v === "waiting") return "pending";

  return null;
}

function normalizeOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const d = new Date(String(value));
  if (!Number.isFinite(d.getTime())) return null;
  return d;
}

export function buildRunScmStateUpdate(patch: RunScmStatePatch, opts?: { now?: Date }): Record<string, unknown> {
  const now = opts?.now ?? new Date();

  const data: Record<string, unknown> = {};
  const provider = normalizeScmProvider(patch.scmProvider);
  const headSha = normalizeOptionalString(patch.scmHeadSha);
  const prNumber = normalizeOptionalInt(patch.scmPrNumber);
  const prUrl = normalizeOptionalString(patch.scmPrUrl);
  const prState = normalizeScmPrState(patch.scmPrState);
  const ciStatus = normalizeScmCiStatus(patch.scmCiStatus);
  const updatedAt = normalizeOptionalDate(patch.scmUpdatedAt);

  if (provider !== undefined) data.scmProvider = provider;
  if (headSha !== undefined) data.scmHeadSha = headSha;
  if (prNumber !== undefined) data.scmPrNumber = prNumber;
  if (prUrl !== undefined) data.scmPrUrl = prUrl;
  if (prState !== undefined) data.scmPrState = prState;
  if (ciStatus !== undefined) data.scmCiStatus = ciStatus;

  const hasAnyField =
    provider !== undefined ||
    headSha !== undefined ||
    prNumber !== undefined ||
    prUrl !== undefined ||
    prState !== undefined ||
    ciStatus !== undefined;

  if (updatedAt !== undefined) {
    data.scmUpdatedAt = updatedAt;
  } else if (hasAnyField) {
    data.scmUpdatedAt = now;
  }

  return data;
}

export async function updateRunScmState(
  deps: { prisma: PrismaDeps },
  runId: string,
  patch: RunScmStatePatch,
  opts?: { now?: Date },
): Promise<void> {
  const data = buildRunScmStateUpdate(patch, opts);
  if (!Object.keys(data).length) return;
  await deps.prisma.run.update({ where: { id: runId }, data: data as any } as any);
}
