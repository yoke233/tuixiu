import { apiPost } from "./client";
import type { PmAnalysis, PmAnalysisMeta } from "../types";

export async function analyzeIssue(issueId: string): Promise<{ analysis: PmAnalysis; meta: PmAnalysisMeta }> {
  const data = await apiPost<{ analysis: PmAnalysis; meta: PmAnalysisMeta }>(`/pm/issues/${issueId}/analyze`, {});
  return data;
}

export async function dispatchIssue(issueId: string, reason?: string): Promise<unknown> {
  const data = await apiPost<unknown>(`/pm/issues/${issueId}/dispatch`, { reason: reason ?? "manual" });
  return data;
}

