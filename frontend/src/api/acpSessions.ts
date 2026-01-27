import { apiGet, apiPost } from "./client";
import type { AcpSessionSummary } from "../types";

export async function listAcpSessions(opts?: { projectId?: string; limit?: number }): Promise<AcpSessionSummary[]> {
  const qs = new URLSearchParams();
  if (opts?.projectId) qs.set("projectId", opts.projectId);
  if (typeof opts?.limit === "number") qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const data = await apiGet<{ sessions: AcpSessionSummary[] }>(`/admin/acp-sessions${suffix}`);
  return data.sessions;
}

export async function cancelAcpSession(runId: string, sessionId: string): Promise<{ ok: true }> {
  const data = await apiPost<{ ok: true }>(`/admin/acp-sessions/cancel`, { runId, sessionId });
  return data;
}

