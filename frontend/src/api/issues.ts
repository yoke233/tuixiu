import { apiGet, apiPost } from "./client";
import type { Issue, Run } from "../types";

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

