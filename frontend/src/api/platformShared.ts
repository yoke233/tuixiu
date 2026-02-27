import { apiGet, apiPatch, apiPost, apiRequest } from "@/api/client";
import type { GitAuthMode, GitCredential, RoleTemplate } from "@/types";

export type CreatePlatformGitCredentialInput = {
  key: string;
  displayName?: string;
  purpose?: string;
  gitAuthMode?: GitAuthMode;
  githubAccessToken?: string;
  gitlabAccessToken?: string;
  gitHttpUsername?: string;
  gitHttpPassword?: string;
  gitSshCommand?: string;
  gitSshKey?: string;
  gitSshKeyB64?: string;
};

export type UpdatePlatformGitCredentialInput = {
  key?: string;
  displayName?: string;
  purpose?: string | null;
  gitAuthMode?: GitAuthMode;
  githubAccessToken?: string | null;
  gitlabAccessToken?: string | null;
  gitHttpUsername?: string | null;
  gitHttpPassword?: string | null;
  gitSshCommand?: string | null;
  gitSshKey?: string | null;
  gitSshKeyB64?: string | null;
};

export async function listPlatformGitCredentials(): Promise<GitCredential[]> {
  const data = await apiGet<{ credentials: GitCredential[] }>("/admin/platform/git-credentials");
  return Array.isArray(data.credentials) ? data.credentials : [];
}

export async function createPlatformGitCredential(
  input: CreatePlatformGitCredentialInput,
): Promise<GitCredential> {
  const data = await apiPost<{ credential: GitCredential }>("/admin/platform/git-credentials", input);
  return data.credential;
}

export async function updatePlatformGitCredential(
  credentialId: string,
  input: UpdatePlatformGitCredentialInput,
): Promise<GitCredential> {
  const data = await apiPatch<{ credential: GitCredential }>(
    `/admin/platform/git-credentials/${credentialId}`,
    input,
  );
  return data.credential;
}

export async function deletePlatformGitCredential(
  credentialId: string,
): Promise<{ credentialId: string }> {
  return await apiRequest<{ credentialId: string }>(
    `/admin/platform/git-credentials/${credentialId}`,
    { method: "DELETE" },
  );
}

export type CreatePlatformRoleInput = {
  key: string;
  displayName: string;
  description?: string;
  promptTemplate?: string;
  initScript?: string;
  initTimeoutSeconds?: number;
  envText?: string;
};

export type UpdatePlatformRoleInput = Omit<
  Partial<CreatePlatformRoleInput>,
  "key"
>;

export async function listPlatformRoles(): Promise<RoleTemplate[]> {
  const data = await apiGet<{ roles: RoleTemplate[] }>("/admin/platform/roles");
  return Array.isArray(data.roles) ? data.roles : [];
}

export async function createPlatformRole(
  input: CreatePlatformRoleInput,
): Promise<RoleTemplate> {
  const data = await apiPost<{ role: RoleTemplate }>("/admin/platform/roles", input);
  return data.role;
}

export async function updatePlatformRole(
  roleId: string,
  input: UpdatePlatformRoleInput,
): Promise<RoleTemplate> {
  const data = await apiPatch<{ role: RoleTemplate }>(`/admin/platform/roles/${roleId}`, input);
  return data.role;
}

export async function deletePlatformRole(roleId: string): Promise<{ roleId: string }> {
  return await apiRequest<{ roleId: string }>(`/admin/platform/roles/${roleId}`, {
    method: "DELETE",
  });
}
