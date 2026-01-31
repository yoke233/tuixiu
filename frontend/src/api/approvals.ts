import { apiGet, apiPost } from "./client";
import type { Approval, Artifact } from "../types";

export async function listApprovals(opts?: { status?: string; limit?: number }): Promise<Approval[]> {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set("status", opts.status);
  if (typeof opts?.limit === "number") qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const data = await apiGet<{ approvals: Approval[] }>(`/approvals${suffix}`);
  return Array.isArray(data.approvals) ? data.approvals : [];
}

export async function approveApproval(id: string, actor?: string): Promise<{ approval: Approval; pr?: Artifact }> {
  const data = await apiPost<{ approval: Approval; pr?: Artifact }>(`/approvals/${id}/approve`, actor ? { actor } : {});
  return data;
}

export async function rejectApproval(id: string, opts?: { actor?: string; reason?: string }): Promise<{ approval: Approval }> {
  const body: Record<string, unknown> = {};
  if (opts?.actor) body.actor = opts.actor;
  if (opts?.reason) body.reason = opts.reason;
  const data = await apiPost<{ approval: Approval }>(`/approvals/${id}/reject`, body);
  return data;
}

