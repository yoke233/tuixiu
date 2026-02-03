import { apiGet, apiPatch, apiPost } from "./client";
import type { Project } from "../types";

export type CreateProjectInput = {
  name: string;
  repoUrl: string;
  scmType?: string;
  defaultBranch?: string;
  workspaceMode?: "worktree" | "clone";
  agentWorkspaceNoticeTemplate?: string;
};

export async function listProjects(): Promise<Project[]> {
  const data = await apiGet<{ projects: Project[] }>("/projects");
  return Array.isArray(data.projects) ? data.projects : [];
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const data = await apiPost<{ project: Project }>("/projects", input);
  return data.project;
}

export type UpdateProjectInput = {
  name?: string;
  repoUrl?: string;
  scmType?: string;
  defaultBranch?: string;
  workspaceMode?: "worktree" | "clone" | null;
  defaultRoleKey?: string | null;
  agentWorkspaceNoticeTemplate?: string | null;
};

export async function updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
  const data = await apiPatch<{ project: Project }>(`/projects/${projectId}`, input);
  return data.project;
}
