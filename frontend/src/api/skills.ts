import { apiGet } from "./client";

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
  importedAt: string;
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

