import { apiGet, apiPost } from "./client";
import type { Project } from "../types";

export type CreateProjectInput = {
  name: string;
  repoUrl: string;
  scmType?: string;
  defaultBranch?: string;
  workspaceMode?: "worktree" | "clone";
  gitAuthMode?: "https_pat" | "ssh";
  gitlabProjectId?: number;
  gitlabAccessToken?: string;
  gitlabWebhookSecret?: string;
  githubAccessToken?: string;
};

export async function listProjects(): Promise<Project[]> {
  const data = await apiGet<{ projects: Project[] }>("/projects");
  return data.projects;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const data = await apiPost<{ project: Project }>("/projects", input);
  return data.project;
}
