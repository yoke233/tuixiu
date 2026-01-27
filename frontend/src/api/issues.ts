import { apiGet, apiPatch, apiPost } from "./client";
import type { Issue, IssueStatus, Run } from "../types";

export type ListIssuesResult = {
  issues: Issue[];
  total: number;
  limit: number;
  offset: number;
};

export type ListIssuesQuery = {
  status?: IssueStatus;
  statuses?: IssueStatus[];
  projectId?: string;
  archived?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
};

export type CreateIssueInput = {
  projectId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  testRequirements?: string;
};

export async function listIssues(query?: ListIssuesQuery): Promise<ListIssuesResult> {
  const params = new URLSearchParams();
  const statuses = query?.statuses?.filter(Boolean) ?? [];
  if (statuses.length) {
    params.set("statuses", statuses.join(","));
  } else if (query?.status) {
    params.set("status", query.status);
  }
  if (query?.projectId) params.set("projectId", query.projectId);
  if (typeof query?.archived === "boolean") params.set("archived", query.archived ? "true" : "false");
  if (query?.q?.trim()) params.set("q", query.q.trim());
  if (typeof query?.limit === "number") params.set("limit", String(query.limit));
  if (typeof query?.offset === "number") params.set("offset", String(query.offset));

  const qs = params.toString();
  const data = await apiGet<{ issues: Issue[]; total: number; limit: number; offset: number }>(`/issues${qs ? `?${qs}` : ""}`);
  return data;
}

export async function getIssue(id: string): Promise<Issue> {
  const data = await apiGet<{ issue: Issue }>(`/issues/${id}`);
  return data.issue;
}

export async function createIssue(input: CreateIssueInput): Promise<{ issue: Issue; run?: Run }> {
  const data = await apiPost<{ issue: Issue; run?: Run }>("/issues", input);
  return data;
}

export async function startIssue(
  id: string,
  input: { agentId?: string; roleKey?: string; worktreeName?: string }
): Promise<{ run: Run }> {
  const data = await apiPost<{ run: Run }>(`/issues/${id}/start`, input);
  return data;
}

export async function updateIssue(
  id: string,
  input: { status?: Exclude<IssueStatus, "running">; archived?: boolean }
): Promise<Issue> {
  const data = await apiPatch<{ issue: Issue }>(`/issues/${id}`, input);
  return data.issue;
}
