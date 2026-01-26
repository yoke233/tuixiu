import { apiGet, apiPost } from "./client";
import type { Artifact, Event, Run } from "../types";

export type RunChangeFile = { path: string; status: string; oldPath?: string };
export type RunChanges = { baseBranch: string; branch: string; files: RunChangeFile[] };
export type RunDiff = { baseBranch: string; branch: string; path: string; diff: string };

export async function getRun(id: string): Promise<Run> {
  const data = await apiGet<{ run: Run }>(`/runs/${id}`);
  return data.run;
}

export async function listRunEvents(runId: string): Promise<Event[]> {
  const data = await apiGet<{ events: Event[] }>(`/runs/${runId}/events`);
  return data.events;
}

export async function getRunChanges(runId: string): Promise<RunChanges> {
  const data = await apiGet<RunChanges>(`/runs/${runId}/changes`);
  return data;
}

export async function getRunDiff(runId: string, path: string): Promise<RunDiff> {
  const data = await apiGet<RunDiff>(`/runs/${runId}/diff?path=${encodeURIComponent(path)}`);
  return data;
}

export async function cancelRun(id: string): Promise<Run> {
  const data = await apiPost<{ run: Run }>(`/runs/${id}/cancel`, {});
  return data.run;
}

export async function completeRun(id: string): Promise<Run> {
  const data = await apiPost<{ run: Run }>(`/runs/${id}/complete`, {});
  return data.run;
}

export async function promptRun(id: string, text: string): Promise<void> {
  await apiPost<{ ok: true }>(`/runs/${id}/prompt`, { text });
}

export async function createRunPr(id: string): Promise<Artifact> {
  const data = await apiPost<{ pr: Artifact }>(`/runs/${id}/create-pr`, {});
  return data.pr;
}

export async function mergeRunPr(id: string): Promise<Artifact> {
  const data = await apiPost<{ pr: Artifact }>(`/runs/${id}/merge-pr`, {});
  return data.pr;
}
