import { apiGet, apiPatch, apiPost, apiRequest } from "./client";
import type { GitAuthMode, GitCredential, Project } from "../types";

export async function listGitCredentials(projectId: string): Promise<GitCredential[]> {
  const data = await apiGet<{ credentials: GitCredential[] }>(`/projects/${projectId}/git-credentials`);
  return Array.isArray(data.credentials) ? data.credentials : [];
}

export type CreateGitCredentialInput = {
  key: string;
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

export async function createGitCredential(projectId: string, input: CreateGitCredentialInput): Promise<GitCredential> {
  const data = await apiPost<{ credential: GitCredential }>(`/projects/${projectId}/git-credentials`, input);
  return data.credential;
}

export type UpdateGitCredentialInput = {
  key?: string;
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

export async function updateGitCredential(
  projectId: string,
  credentialId: string,
  input: UpdateGitCredentialInput,
): Promise<GitCredential> {
  const data = await apiPatch<{ credential: GitCredential }>(
    `/projects/${projectId}/git-credentials/${credentialId}`,
    input,
  );
  return data.credential;
}

export async function deleteGitCredential(projectId: string, credentialId: string): Promise<{ credentialId: string }> {
  return await apiRequest<{ credentialId: string }>(`/projects/${projectId}/git-credentials/${credentialId}`, {
    method: "DELETE",
  });
}

export type SetGitCredentialDefaultsInput = {
  runGitCredentialId?: string | null;
  scmAdminCredentialId?: string | null;
};

export async function setGitCredentialDefaults(projectId: string, input: SetGitCredentialDefaultsInput): Promise<Project> {
  const data = await apiPatch<{ project: Project }>(`/projects/${projectId}/git-credentials-defaults`, input);
  return data.project;
}
