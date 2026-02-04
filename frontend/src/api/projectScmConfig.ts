import { apiGet, apiPut } from "@/api/client";
import type { ProjectScmConfig } from "@/types";

export async function getProjectScmConfig(projectId: string): Promise<ProjectScmConfig> {
  const data = await apiGet<{ scmConfig: ProjectScmConfig }>(`/projects/${projectId}/scm-config`);
  return data.scmConfig;
}

export type UpdateProjectScmConfigInput = {
  gitlabProjectId?: number | null;
  gitlabWebhookSecret?: string | null;
  githubPollingEnabled?: boolean;
};

export async function updateProjectScmConfig(
  projectId: string,
  input: UpdateProjectScmConfigInput,
): Promise<ProjectScmConfig> {
  const data = await apiPut<{ scmConfig: ProjectScmConfig }>(`/projects/${projectId}/scm-config`, input);
  return data.scmConfig;
}

