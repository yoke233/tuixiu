import { apiGet, apiPost } from "@/api/client";
import type { GitHubIssue, Issue } from "@/types";

export async function listGitHubIssues(
  projectId: string,
  opts?: { state?: "open" | "closed" | "all"; page?: number; limit?: number }
): Promise<{ issues: GitHubIssue[]; page: number; limit: number }> {
  const qs = new URLSearchParams();
  if (opts?.state) qs.set("state", opts.state);
  if (typeof opts?.page === "number") qs.set("page", String(opts.page));
  if (typeof opts?.limit === "number") qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const data = await apiGet<{ issues: GitHubIssue[]; page: number; limit: number }>(
    `/projects/${projectId}/github/issues${suffix}`
  );
  return {
    issues: Array.isArray(data.issues) ? data.issues : [],
    page: typeof data.page === "number" && Number.isFinite(data.page) ? data.page : (opts?.page ?? 1),
    limit: typeof data.limit === "number" && Number.isFinite(data.limit) ? data.limit : (opts?.limit ?? 20),
  };
}

export async function importGitHubIssue(
  projectId: string,
  input: { number?: number; url?: string }
): Promise<{ issue: Issue; imported: boolean }> {
  const data = await apiPost<{ issue: Issue; imported: boolean }>(`/projects/${projectId}/github/issues/import`, input);
  return data;
}
