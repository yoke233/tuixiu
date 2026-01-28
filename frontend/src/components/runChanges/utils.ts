import type { Project } from "../../types";

export function normalizeRepoWebUrl(repoUrl: string): string | null {
  const raw = repoUrl.trim();
  if (!raw) return null;

  // https://host/org/repo(.git)
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      u.hash = "";
      u.search = "";
      u.pathname = u.pathname.replace(/\.git$/i, "");
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  // git@host:org/repo(.git)
  const m = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (m) {
    const host = m[1];
    const path = m[2].replace(/\.git$/i, "");
    return `https://${host}/${path}`.replace(/\/+$/, "");
  }

  return null;
}

export function buildCreatePrUrl(opts: { project?: Project; baseBranch: string; branch: string }): string | null {
  const web = opts.project?.repoUrl ? normalizeRepoWebUrl(opts.project.repoUrl) : null;
  if (!web) return null;

  const scm = (opts.project?.scmType || "gitlab").toLowerCase();
  const base = encodeURIComponent(opts.baseBranch);
  const head = encodeURIComponent(opts.branch);

  if (scm === "github") {
    return `${web}/compare/${base}...${head}?expand=1`;
  }
  if (scm === "gitlab" || scm === "codeup") {
    const qs = new URLSearchParams({
      "merge_request[source_branch]": opts.branch,
      "merge_request[target_branch]": opts.baseBranch,
    });
    return `${web}/-/merge_requests/new?${qs.toString()}`;
  }

  // gitee / unknown：先回退到仓库链接
  return web;
}

