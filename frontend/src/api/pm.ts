import { apiGet, apiPost } from "./client";
import type { PmAnalysis, PmAnalysisMeta, PmNextAction } from "../types";

export async function analyzeIssue(issueId: string): Promise<{ analysis: PmAnalysis; meta: PmAnalysisMeta }> {
  const data = await apiPost<{ analysis: PmAnalysis; meta: PmAnalysisMeta }>(`/pm/issues/${issueId}/analyze`, {});
  return data;
}

export async function dispatchIssue(issueId: string, reason?: string): Promise<unknown> {
  const data = await apiPost<unknown>(`/pm/issues/${issueId}/dispatch`, { reason: reason ?? "manual" });
  return data;
}

export async function autoReviewRun(runId: string): Promise<{ runId: string; artifactId: string; report: unknown }> {
  const data = await apiPost<{ runId: string; artifactId: string; report: unknown }>(`/pm/runs/${runId}/auto-review`, {});
  return data;
}

export async function getIssueNextAction(issueId: string): Promise<PmNextAction> {
  const data = await apiGet<{ nextAction: PmNextAction }>(`/pm/issues/${issueId}/next-action`);
  return data.nextAction;
}
