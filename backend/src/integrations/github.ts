export type GitHubAuth = {
  apiBaseUrl: string; // https://api.github.com or https://<host>/api/v3
  owner: string;
  repo: string;
  accessToken: string;
};

export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed" | string;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  draft?: boolean;
  updated_at?: string;
};

export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed" | string;
  html_url: string;
  labels?: unknown[];
  updated_at?: string;
  pull_request?: unknown;
};

export type GitHubMergeResult = {
  merged: boolean;
  message: string;
  sha?: string;
};

export type GitHubIssueComment = {
  id: number;
  html_url: string;
  body?: string | null;
  created_at?: string;
};

export type ParsedGitHubRepo = {
  host: string;
  owner: string;
  repo: string;
  webBaseUrl: string;
  apiBaseUrl: string;
};

function normalizeRepoUrlPath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\.git$/i, "");
}

export function parseGitHubRepo(repoUrl: string): ParsedGitHubRepo | null {
  const raw = repoUrl.trim();
  if (!raw) return null;

  // https://host/owner/repo(.git)
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      const parts = normalizeRepoUrlPath(u.pathname).split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0];
      const repo = parts[1];
      const host = u.host;
      const webBaseUrl = `${u.protocol}//${host}/${owner}/${repo}`;
      const apiBaseUrl = host.toLowerCase() === "github.com" ? "https://api.github.com" : `${u.protocol}//${host}/api/v3`;
      return { host, owner, repo, webBaseUrl, apiBaseUrl };
    } catch {
      return null;
    }
  }

  // git@host:owner/repo(.git)
  const ssh = raw.match(/^git@([^:]+):(.+)$/i);
  if (ssh) {
    const host = ssh[1];
    const path = normalizeRepoUrlPath(ssh[2]);
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1];
    const webBaseUrl = `https://${host}/${owner}/${repo}`;
    const apiBaseUrl = host.toLowerCase() === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
    return { host, owner, repo, webBaseUrl, apiBaseUrl };
  }

  // ssh://git@host/owner/repo(.git)
  if (raw.startsWith("ssh://")) {
    try {
      const u = new URL(raw);
      const parts = normalizeRepoUrlPath(u.pathname).split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const owner = parts[0];
      const repo = parts[1];
      const host = u.host;
      const webBaseUrl = `https://${host}/${owner}/${repo}`;
      const apiBaseUrl = host.toLowerCase() === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
      return { host, owner, repo, webBaseUrl, apiBaseUrl };
    } catch {
      return null;
    }
  }

  return null;
}

function joinApiUrl(apiBaseUrl: string, path: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function githubRequest<T>(
  auth: GitHubAuth,
  opts: { method: string; path: string; body?: unknown }
): Promise<T> {
  const url = joinApiUrl(auth.apiBaseUrl, opts.path);
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      "x-github-api-version": "2022-11-28"
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${opts.method} ${opts.path} failed: ${res.status} ${text}`.trim());
  }

  return (await res.json()) as T;
}

export async function listIssues(
  auth: GitHubAuth,
  params: { state?: "open" | "closed" | "all"; page?: number; perPage?: number }
): Promise<GitHubIssue[]> {
  const state = params.state ?? "open";
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 50;
  const qs = new URLSearchParams({
    state,
    page: String(page),
    per_page: String(perPage)
  });

  const items = await githubRequest<GitHubIssue[]>(auth, {
    method: "GET",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/issues?${qs.toString()}`
  });

  // GitHub 会把 PR 也算在 issues API 里，带 pull_request 字段。
  return items.filter((i) => !(i as any)?.pull_request);
}

export async function getIssue(auth: GitHubAuth, params: { issueNumber: number }): Promise<GitHubIssue> {
  const issue = await githubRequest<GitHubIssue>(auth, {
    method: "GET",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/issues/${encodeURIComponent(
      String(params.issueNumber)
    )}`
  });

  if ((issue as any)?.pull_request) {
    throw new Error(`GitHub issue ${params.issueNumber} is a pull request`);
  }

  return issue;
}

export async function createIssueComment(
  auth: GitHubAuth,
  params: { issueNumber: number; body: string }
): Promise<GitHubIssueComment> {
  return await githubRequest<GitHubIssueComment>(auth, {
    method: "POST",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/issues/${encodeURIComponent(
      String(params.issueNumber)
    )}/comments`,
    body: { body: params.body }
  });
}

export async function createPullRequest(
  auth: GitHubAuth,
  params: { head: string; base: string; title: string; body?: string }
): Promise<GitHubPullRequest> {
  return await githubRequest<GitHubPullRequest>(auth, {
    method: "POST",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/pulls`,
    body: {
      title: params.title,
      head: params.head,
      base: params.base,
      body: params.body ?? ""
    }
  });
}

export async function mergePullRequest(
  auth: GitHubAuth,
  params: {
    pullNumber: number;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string;
    commitMessage?: string;
  }
): Promise<GitHubMergeResult> {
  return await githubRequest<GitHubMergeResult>(auth, {
    method: "PUT",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/pulls/${encodeURIComponent(
      String(params.pullNumber)
    )}/merge`,
    body: {
      merge_method: params.mergeMethod ?? "merge",
      commit_title: params.commitTitle,
      commit_message: params.commitMessage
    }
  });
}

export async function getPullRequest(
  auth: GitHubAuth,
  params: { pullNumber: number }
): Promise<GitHubPullRequest> {
  return await githubRequest<GitHubPullRequest>(auth, {
    method: "GET",
    path: `/repos/${encodeURIComponent(auth.owner)}/${encodeURIComponent(auth.repo)}/pulls/${encodeURIComponent(
      String(params.pullNumber)
    )}`
  });
}
