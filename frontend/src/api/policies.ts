import { apiGet, apiPut } from "@/api/client";
import type { PmPolicy } from "@/types";

export type PolicySource = "project" | "default";

export async function getPmPolicy(projectId: string): Promise<{ policy: PmPolicy; source: PolicySource }> {
  const q = encodeURIComponent(projectId);
  const data = await apiGet<{ projectId: string; policy: PmPolicy; source: PolicySource }>(`/policies?projectId=${q}`);
  return { policy: data.policy, source: data.source };
}

export async function updatePmPolicy(projectId: string, policy: PmPolicy): Promise<{ policy: PmPolicy }> {
  const q = encodeURIComponent(projectId);
  const data = await apiPut<{ projectId: string; policy: PmPolicy }>(`/policies?projectId=${q}`, { policy });
  return { policy: data.policy };
}

