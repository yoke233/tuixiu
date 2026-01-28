import { apiGet, apiPost } from "./client";
import type { Approval, Artifact, Event, Run } from "../types";
import type { ContentBlock } from "../acp/contentBlocks";

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

export async function promptRun(id: string, prompt: ContentBlock[]): Promise<void> {
  await apiPost<{ ok: true }>(`/runs/${id}/prompt`, { prompt });
}

export type UploadedAttachment = {
  id: string;
  runId: string;
  mimeType: string;
  size: number;
  sha256: string;
  uri: string;
};

export async function uploadRunAttachment(
  runId: string,
  input: { mimeType: string; base64: string; name?: string }
): Promise<UploadedAttachment> {
  const data = await apiPost<{ attachment: UploadedAttachment }>(`/runs/${runId}/attachments`, input);
  return data.attachment;
}

export async function pauseRun(id: string): Promise<void> {
  await apiPost<{ ok: true }>(`/runs/${id}/pause`, {});
}

export async function submitRun(
  id: string,
  input: {
    verdict: "approve" | "changes_requested";
    comment?: string;
    squash?: boolean;
    mergeCommitMessage?: string;
  }
): Promise<{ ok: true; blocked?: boolean }> {
  const data = await apiPost<{ ok: true; blocked?: boolean }>(`/runs/${id}/submit`, input);
  return data;
}


export async function createRunPr(id: string): Promise<Artifact> {
  const data = await apiPost<{ pr: Artifact }>(`/runs/${id}/create-pr`, {});
  return data.pr;
}

export async function mergeRunPr(id: string): Promise<Artifact> {
  const data = await apiPost<{ pr: Artifact }>(`/runs/${id}/merge-pr`, {});
  return data.pr;
}

export async function requestMergeRunPr(id: string): Promise<Approval> {
  const data = await apiPost<{ approval: Approval }>(`/runs/${id}/request-merge-pr`, {});
  return data.approval;
}

export async function syncRunPr(id: string): Promise<Artifact> {
  const data = await apiPost<{ pr: Artifact }>(`/runs/${id}/sync-pr`, {});
  return data.pr;
}
