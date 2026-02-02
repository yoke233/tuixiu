import { apiGet, apiPost } from "./client";
import type { SandboxStatus, SandboxSummary } from "../types";

export async function listSandboxes(opts?: {
  proxyId?: string;
  status?: SandboxStatus;
  limit?: number;
  offset?: number;
}): Promise<{ total: number; limit: number; offset: number; sandboxes: SandboxSummary[] }> {
  const qs = new URLSearchParams();
  if (opts?.proxyId) qs.set("proxyId", opts.proxyId);
  if (opts?.status) qs.set("status", opts.status);
  if (typeof opts?.limit === "number") qs.set("limit", String(opts.limit));
  if (typeof opts?.offset === "number") qs.set("offset", String(opts.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  return apiGet(`/admin/sandboxes${suffix}`);
}

export async function reportSandboxInventory(proxyId: string): Promise<{ ok: true }> {
  const data = await apiPost<{ ok: true }>(`/admin/sandboxes/control`, {
    action: "report_inventory",
    proxyId,
  });
  return data;
}

export async function pruneSandboxOrphans(proxyId: string): Promise<{ ok: true; requestId: string }> {
  return apiPost<{ ok: true; requestId: string }>(`/admin/sandboxes/control`, {
    action: "prune_orphans",
    proxyId,
  });
}

export async function removeSandboxWorkspace(runId: string): Promise<{ ok: true; requestId: string }> {
  return apiPost<{ ok: true; requestId: string }>(`/admin/sandboxes/control`, {
    action: "remove_workspace",
    runId,
  });
}

export async function controlSandboxForRun(
  runId: string,
  action: "inspect" | "ensure_running" | "stop" | "remove",
): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/admin/sandboxes/control`, {
    action,
    runId,
  });
}
