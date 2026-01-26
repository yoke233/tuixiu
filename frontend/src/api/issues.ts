import { apiGet, apiPatch, apiPost } from "./client";
import type { Issue, IssueStatus, Run } from "../types";

export type ListIssuesResult = {
  issues: Issue[];
  total: number;
  limit: number;
  offset: number;
};

export type CreateIssueInput = {
  projectId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  testRequirements?: string;
};

export async function listIssues(): Promise<ListIssuesResult> {
  const data = await apiGet<{ issues: Issue[]; total: number; limit: number; offset: number }>(
    "/issues"
  );
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

export async function startIssue(id: string, input: { agentId?: string }): Promise<{ run: Run }> {
  const data = await apiPost<{ run: Run }>(`/issues/${id}/start`, input);
  return data;
}

export async function updateIssue(id: string, input: { status?: Exclude<IssueStatus, "running"> }): Promise<Issue> {
  const data = await apiPatch<{ issue: Issue }>(`/issues/${id}`, input);
  return data.issue;
}
