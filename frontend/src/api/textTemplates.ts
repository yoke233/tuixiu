import { apiGet, apiPatch } from "./client";

export type TextTemplateMap = Record<string, string>;

export type ProjectTextTemplates = {
  projectId: string;
  platform: TextTemplateMap;
  overrides: TextTemplateMap;
  effective: TextTemplateMap;
};

export async function listPlatformTextTemplates(): Promise<TextTemplateMap> {
  const data = await apiGet<{ templates: TextTemplateMap }>("/admin/text-templates");
  return data.templates;
}

export async function patchPlatformTextTemplates(patch: Record<string, string | null>): Promise<TextTemplateMap> {
  const data = await apiPatch<{ templates: TextTemplateMap }>("/admin/text-templates", { templates: patch });
  return data.templates;
}

export async function getProjectTextTemplates(projectId: string): Promise<ProjectTextTemplates> {
  return await apiGet<ProjectTextTemplates>(`/admin/projects/${projectId}/text-templates`);
}

export async function patchProjectTextTemplates(
  projectId: string,
  patch: Record<string, string | null>,
): Promise<ProjectTextTemplates> {
  return await apiPatch<ProjectTextTemplates>(`/admin/projects/${projectId}/text-templates`, { templates: patch });
}
