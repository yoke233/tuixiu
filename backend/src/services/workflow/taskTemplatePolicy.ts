import type { PrismaDeps } from "../../deps.js";
import { taskTemplateOverridesSchema } from "./taskTemplateResolver.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function getTaskTemplatesForProject(deps: { prisma: PrismaDeps }, projectId: string): Promise<
  | { success: true; data: { projectId: string; taskTemplates: Record<string, unknown>; source: "project" | "default" } }
  | { success: false; error: { code: string; message: string } }
> {
  const project = await deps.prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, branchProtection: true },
  });
  if (!project) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

  const branchProtection = (project as any).branchProtection;
  const candidate = isRecord(branchProtection) ? (branchProtection as any).taskTemplates : undefined;
  const parsed = taskTemplateOverridesSchema.safeParse(candidate);
  if (!parsed.success) {
    return { success: true, data: { projectId: project.id, taskTemplates: {}, source: "default" } };
  }

  return { success: true, data: { projectId: project.id, taskTemplates: parsed.data, source: "project" } };
}

export async function setTaskTemplatesForProject(
  deps: { prisma: PrismaDeps },
  opts: { projectId: string; taskTemplates: unknown },
): Promise<
  | { success: true; data: { projectId: string; taskTemplates: Record<string, unknown> } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const validated = taskTemplateOverridesSchema.safeParse(opts.taskTemplates);
  if (!validated.success) {
    return {
      success: false,
      error: { code: "BAD_TASK_TEMPLATES", message: "taskTemplates 校验失败", details: validated.error.message },
    };
  }

  const project = await deps.prisma.project.findUnique({
    where: { id: opts.projectId },
    select: { id: true, branchProtection: true },
  });
  if (!project) return { success: false, error: { code: "NOT_FOUND", message: "Project 不存在" } };

  const existing = (project as any).branchProtection;
  const nextBranchProtection = isRecord(existing) ? { ...existing, taskTemplates: validated.data } : { taskTemplates: validated.data };

  await deps.prisma.project.update({
    where: { id: opts.projectId },
    data: { branchProtection: nextBranchProtection as any },
  });

  return { success: true, data: { projectId: project.id, taskTemplates: validated.data } };
}

