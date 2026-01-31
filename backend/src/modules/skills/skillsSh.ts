export type SkillsShRef = {
  sourceType: "skills.sh";
  sourceKey: string;
  sourceRef: string;
  owner: string;
  repo: string;
  skill: string;
  githubRepoUrl: string;
  skillDir: string;
};

function stripAnsi(input: string): string {
  // Minimal ANSI escape stripper (covers CSI sequences like \x1b[0m).
  // We avoid bringing an extra dependency for this.
  return input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function safeSegment(value: string): string | null {
  const v = stripAnsi(value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!v) return null;
  if (v.includes("/") || v.includes("\\") || v.includes("..")) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(v)) return null;
  return v;
}

export function parseSkillsShSourceKey(sourceKey: string): SkillsShRef | null {
  const raw = sourceKey.trim();
  const m = /^([^/\s]+)\/([^/\s]+)@([^/\s]+)$/.exec(raw);
  if (!m) return null;

  const owner = safeSegment(m[1] ?? "");
  const repo = safeSegment(m[2] ?? "");
  const skill = safeSegment(m[3] ?? "");
  if (!owner || !repo || !skill) return null;

  return {
    sourceType: "skills.sh",
    sourceKey: `${owner}/${repo}@${skill}`,
    sourceRef: `https://skills.sh/${owner}/${repo}/${skill}`,
    owner,
    repo,
    skill,
    githubRepoUrl: `https://github.com/${owner}/${repo}`,
    skillDir: `skills/${skill}`,
  };
}

export function parseSkillsShUrl(url: string): SkillsShRef | null {
  const trimmed = url.trim();
  const m = /^https?:\/\/skills\.sh\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/.exec(trimmed);
  if (!m) return null;

  const owner = safeSegment(m[1] ?? "");
  const repo = safeSegment(m[2] ?? "");
  const skill = safeSegment(m[3] ?? "");
  if (!owner || !repo || !skill) return null;

  return {
    sourceType: "skills.sh",
    sourceKey: `${owner}/${repo}@${skill}`,
    sourceRef: `https://skills.sh/${owner}/${repo}/${skill}`,
    owner,
    repo,
    skill,
    githubRepoUrl: `https://github.com/${owner}/${repo}`,
    skillDir: `skills/${skill}`,
  };
}
