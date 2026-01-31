import { apiGet, apiPost } from "./client";

export type SkillLatestVersion = {
  versionId: string;
  contentHash: string;
  importedAt: string;
};

export type SkillSearchItem = {
  skillId: string;
  name: string;
  description: string | null;
  tags: string[];
  installed: boolean;
  latestVersion: SkillLatestVersion | null;
  installs?: number | null;
  sourceType?: string;
  sourceKey?: string;
  sourceRef?: string;
  sourceRevision?: string | null;
  githubRepoUrl?: string;
  skillDir?: string;
};

export type SkillSearchResult = {
  provider: string;
  items: SkillSearchItem[];
  nextCursor: string | null;
};

export type SkillDetail = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type SkillVersion = {
  id: string;
  contentHash: string;
  storageUri: string | null;
  source: unknown | null;
  sourceRevision: string | null;
  packageSize: number | null;
  manifestJson: unknown | null;
  importedAt: string;
};

export type SkillImportResponse = {
  mode: string;
  source: {
    sourceType: string;
    sourceKey: string;
    sourceRef: string;
    owner: string;
    repo: string;
    skill: string;
    githubRepoUrl: string;
    skillDir: string;
  };
  meta: { name: string; description: string | null; tags: string[] };
  contentHash: string;
  fileCount: number;
  totalBytes: number;
  skill?: {
    id: string;
    name: string;
    description: string | null;
    tags: string[];
    sourceType: string | null;
    sourceKey: string | null;
    latestVersionId: string | null;
  };
  skillVersion?: {
    id: string;
    contentHash: string;
    storageUri: string | null;
    importedAt: string;
  };
  createdSkill?: boolean;
  createdVersion?: boolean;
  published?: boolean;
};

export type SkillCheckUpdatesResponse = {
  items: Array<{
    skillId: string;
    name: string;
    sourceType: string;
    sourceKey: string;
    current: { versionId: string; contentHash: string } | null;
    candidate: { contentHash: string; fileCount: number; totalBytes: number } | null;
    hasUpdate?: boolean;
    error?: string;
  }>;
};

export type SkillUpdateResponse = {
  publishLatest: boolean;
  results: Array<{
    skillId: string;
    ok: boolean;
    error?: string;
    createdVersion?: boolean;
    published?: boolean;
    contentHash?: string;
    storageUri?: string;
    skillVersionId?: string;
  }>;
};

export async function searchSkills(input: {
  q?: string;
  tags?: string;
  limit?: number;
  cursor?: string;
  provider?: string;
}): Promise<SkillSearchResult> {
  const params = new URLSearchParams();
  if (input.provider) params.set("provider", input.provider);
  if (input.q) params.set("q", input.q);
  if (input.tags) params.set("tags", input.tags);
  if (typeof input.limit === "number" && Number.isFinite(input.limit)) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);

  const qs = params.toString();
  return await apiGet<SkillSearchResult>(`/admin/skills/search${qs ? `?${qs}` : ""}`);
}

export async function getSkill(skillId: string): Promise<SkillDetail> {
  const data = await apiGet<{ skill: SkillDetail }>(`/admin/skills/${skillId}`);
  return data.skill;
}

export async function listSkillVersions(skillId: string): Promise<SkillVersion[]> {
  const data = await apiGet<{ skillId: string; versions: SkillVersion[] }>(`/admin/skills/${skillId}/versions`);
  return Array.isArray(data.versions) ? data.versions : [];
}

export async function importSkill(input: {
  provider: string;
  sourceRef: string;
  mode?: "dry-run" | "new-skill" | "new-version";
}): Promise<SkillImportResponse> {
  return await apiPost<SkillImportResponse>("/admin/skills/import", input);
}

export async function checkSkillUpdates(input: { skillIds?: string[]; sourceType?: string }): Promise<SkillCheckUpdatesResponse> {
  return await apiPost<SkillCheckUpdatesResponse>("/admin/skills/check-updates", input);
}

export async function updateSkills(input: { skillIds: string[]; publishLatest?: boolean }): Promise<SkillUpdateResponse> {
  return await apiPost<SkillUpdateResponse>("/admin/skills/update", input);
}
