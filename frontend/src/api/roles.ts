import { apiGet, apiPatch, apiPost, apiRequest } from "./client";
import type { AgentInputsManifestV1, RoleTemplate } from "../types";

export type CreateRoleTemplateInput = {
  key: string;
  displayName: string;
  description?: string;
  promptTemplate?: string;
  initScript?: string;
  initTimeoutSeconds?: number;
  envText?: string;
  agentInputs?: AgentInputsManifestV1 | null;
};

export async function listRoles(projectId: string): Promise<RoleTemplate[]> {
  const data = await apiGet<{ roles: RoleTemplate[] }>(`/projects/${projectId}/roles`);
  return Array.isArray(data.roles) ? data.roles : [];
}

export async function createRole(projectId: string, input: CreateRoleTemplateInput): Promise<RoleTemplate> {
  const data = await apiPost<{ role: RoleTemplate }>(`/projects/${projectId}/roles`, input);
  return data.role;
}

export async function updateRole(
  projectId: string,
  roleId: string,
  input: Partial<Omit<CreateRoleTemplateInput, "key">>
): Promise<RoleTemplate> {
  const data = await apiPatch<{ role: RoleTemplate }>(`/projects/${projectId}/roles/${roleId}`, input);
  return data.role;
}

export async function deleteRole(projectId: string, roleId: string): Promise<{ roleId: string }> {
  return await apiRequest<{ roleId: string }>(`/projects/${projectId}/roles/${roleId}`, { method: "DELETE" });
}

