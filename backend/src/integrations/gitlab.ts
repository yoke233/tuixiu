export type GitLabAuth = {
  baseUrl: string; // e.g. https://gitlab.example.com
  projectId: number;
  accessToken: string;
};

export type GitLabMergeRequest = {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  merge_status?: string;
  detailed_merge_status?: string;
};

function normalizeHostBaseUrl(repoUrl: string): string | null {
  const raw = repoUrl.trim();
  if (!raw) return null;

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  const m = raw.match(/^git@([^:]+):/i);
  if (m) return `https://${m[1]}`;

  return null;
}

export function inferGitlabBaseUrl(repoUrl: string): string | null {
  return normalizeHostBaseUrl(repoUrl);
}

function joinApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}/api/v4${p}`;
}

async function gitlabRequest<T>(auth: GitLabAuth, opts: { method: string; path: string; body?: unknown }): Promise<T> {
  const url = joinApiUrl(auth.baseUrl, opts.path);
  const res = await fetch(url, {
    method: opts.method,
    headers: {
      "content-type": "application/json",
      "private-token": auth.accessToken
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitLab API ${opts.method} ${opts.path} failed: ${res.status} ${text}`.trim());
  }

  return (await res.json()) as T;
}

export async function createMergeRequest(
  auth: GitLabAuth,
  params: { sourceBranch: string; targetBranch: string; title: string; description?: string }
): Promise<GitLabMergeRequest> {
  return await gitlabRequest<GitLabMergeRequest>(auth, {
    method: "POST",
    path: `/projects/${encodeURIComponent(String(auth.projectId))}/merge_requests`,
    body: {
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      title: params.title,
      description: params.description ?? ""
    }
  });
}

export async function mergeMergeRequest(
  auth: GitLabAuth,
  params: { iid: number; squash?: boolean; mergeCommitMessage?: string }
): Promise<GitLabMergeRequest> {
  return await gitlabRequest<GitLabMergeRequest>(auth, {
    method: "PUT",
    path: `/projects/${encodeURIComponent(String(auth.projectId))}/merge_requests/${encodeURIComponent(String(params.iid))}/merge`,
    body: {
      squash: params.squash ?? false,
      merge_commit_message: params.mergeCommitMessage
    }
  });
}

export async function getMergeRequest(auth: GitLabAuth, params: { iid: number }): Promise<GitLabMergeRequest> {
  return await gitlabRequest<GitLabMergeRequest>(auth, {
    method: "GET",
    path: `/projects/${encodeURIComponent(String(auth.projectId))}/merge_requests/${encodeURIComponent(String(params.iid))}`
  });
}

