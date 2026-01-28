import { z } from "zod";

import type { TaskTemplate, TaskTemplateStep, TaskTrack } from "../taskTemplates.js";
import { getTaskTemplate } from "../taskTemplates.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTaskTrack(value: unknown): TaskTrack | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "quick" || v === "planning" || v === "enterprise") return v;
  return null;
}

function inferTaskTrackFromTemplateKey(templateKey: string): TaskTrack | null {
  const k = String(templateKey ?? "").trim().toLowerCase();
  if (!k) return null;
  if (k.startsWith("quick.")) return "quick";
  if (k.startsWith("planning.")) return "planning";
  if (k.startsWith("enterprise.")) return "enterprise";
  return null;
}

export const taskTemplateStepSchema: z.ZodType<TaskTemplateStep> = z
  .object({
    key: z.string().min(1),
    kind: z.string().min(1),
    executorType: z.enum(["agent", "ci", "human", "system"]),
    roleKey: z.string().min(1).optional(),
    params: z.record(z.unknown()).optional(),
  })
  .strict();

export const taskTemplateOverrideSchema = z
  .object({
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    track: z.enum(["quick", "planning", "enterprise"]).optional(),
    steps: z.array(taskTemplateStepSchema).min(1),
  })
  .strict();

export type TaskTemplateOverride = z.infer<typeof taskTemplateOverrideSchema>;

export const taskTemplateOverridesSchema: z.ZodType<Record<string, TaskTemplateOverride>> = z.record(taskTemplateOverrideSchema);

function getTaskTemplateOverridesFromBranchProtection(branchProtection: unknown): Record<string, TaskTemplateOverride> | null {
  if (!isRecord(branchProtection)) return null;
  const candidate = (branchProtection as any).taskTemplates;
  if (!isRecord(candidate)) return null;
  const parsed = taskTemplateOverridesSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data;
}

export function resolveTaskTemplateForProject(opts: {
  templateKey: string;
  branchProtection: unknown;
}): { template: TaskTemplate; source: "default" | "project" } | null {
  const templateKey = String(opts.templateKey ?? "").trim();
  if (!templateKey) return null;

  const overrides = getTaskTemplateOverridesFromBranchProtection(opts.branchProtection);
  const override = overrides?.[templateKey] ?? null;
  const base = getTaskTemplate(templateKey);

  if (!override) {
    if (!base) return null;
    return { template: base, source: "default" };
  }

  const template: TaskTemplate = {
    key: templateKey,
    displayName: override.displayName ?? base?.displayName ?? templateKey,
    description: override.description ?? base?.description,
    track: normalizeTaskTrack(override.track) ?? base?.track ?? inferTaskTrackFromTemplateKey(templateKey) ?? undefined,
    steps: override.steps,
  };

  return { template, source: "project" };
}
