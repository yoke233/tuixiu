import { apiGet, apiPut } from "./client";

export type RoleSkillItem = {
  skillId: string;
  name: string;
  versionPolicy: "latest" | "pinned";
  pinnedVersionId: string | null;
  enabled: boolean;
};

export type RoleSkillsResponse = {
  projectId: string;
  roleId: string;
  items: RoleSkillItem[];
};

export async function getRoleSkills(projectId: string, roleId: string): Promise<RoleSkillsResponse> {
  return await apiGet<RoleSkillsResponse>(`/admin/projects/${projectId}/roles/${roleId}/skills`);
}

export async function putRoleSkills(
  projectId: string,
  roleId: string,
  items: Array<{
    skillId: string;
    versionPolicy?: "latest" | "pinned";
    pinnedVersionId?: string;
    enabled?: boolean;
  }>,
): Promise<RoleSkillsResponse> {
  return await apiPut<RoleSkillsResponse>(`/admin/projects/${projectId}/roles/${roleId}/skills`, { items });
}

