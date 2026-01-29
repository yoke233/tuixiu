import type { PrismaDeps } from "../../db.js";
import { uuidv7 } from "../../utils/uuid.js";
import { normalizeTemplateText, renderTextTemplate } from "../../utils/textTemplate.js";

export type TextTemplateSource = "project" | "platform" | "missing";

export async function getTextTemplateRaw(
  deps: { prisma: PrismaDeps },
  opts: { key: string; projectId?: string | null },
): Promise<{ template: string | null; source: TextTemplateSource }> {
  const key = String(opts.key ?? "").trim();
  const projectId = typeof opts.projectId === "string" ? opts.projectId.trim() : "";
  if (!key) return { template: null, source: "missing" };

  if (projectId) {
    const projectDelegate = (deps.prisma as any).projectTextTemplate;
    const project =
      projectDelegate && typeof projectDelegate.findUnique === "function"
        ? await projectDelegate.findUnique({ where: { projectId_key: { projectId, key } } as any }).catch(() => null)
        : null;
    const t = project && typeof (project as any).template === "string" ? normalizeTemplateText((project as any).template) : "";
    if (t) return { template: t, source: "project" };
  }

  const platformDelegate = (deps.prisma as any).platformTextTemplate;
  const platform =
    platformDelegate && typeof platformDelegate.findUnique === "function"
      ? await platformDelegate.findUnique({ where: { key } }).catch(() => null)
      : null;
  const t = platform && typeof (platform as any).template === "string" ? normalizeTemplateText((platform as any).template) : "";
  if (t) return { template: t, source: "platform" };

  return { template: null, source: "missing" };
}

export async function renderTextTemplateFromDb(
  deps: { prisma: PrismaDeps },
  opts: { key: string; projectId?: string | null; vars: Record<string, unknown>; missingText?: string },
): Promise<string> {
  const { template } = await getTextTemplateRaw(deps, { key: opts.key, projectId: opts.projectId });
  if (!template) return opts.missingText ?? `（缺少模板：${String(opts.key ?? "")}）`;
  return normalizeTemplateText(renderTextTemplate(template, opts.vars));
}

export async function listPlatformTextTemplates(deps: { prisma: PrismaDeps }): Promise<Record<string, string>> {
  const platformDelegate = (deps.prisma as any).platformTextTemplate;
  if (!platformDelegate || typeof platformDelegate.findMany !== "function") return {};
  const rows = await platformDelegate.findMany({ orderBy: { key: "asc" } });
  const out: Record<string, string> = {};
  for (const row of rows as any[]) {
    const key = String(row?.key ?? "").trim();
    if (!key) continue;
    out[key] = normalizeTemplateText(String(row?.template ?? ""));
  }
  return out;
}

export async function listProjectTextTemplates(
  deps: { prisma: PrismaDeps },
  projectId: string,
): Promise<Record<string, string>> {
  const pid = String(projectId ?? "").trim();
  if (!pid) return {};
  const projectDelegate = (deps.prisma as any).projectTextTemplate;
  if (!projectDelegate || typeof projectDelegate.findMany !== "function") return {};
  const rows = await projectDelegate.findMany({ where: { projectId: pid } as any, orderBy: { key: "asc" } });
  const out: Record<string, string> = {};
  for (const row of rows as any[]) {
    const key = String(row?.key ?? "").trim();
    if (!key) continue;
    out[key] = normalizeTemplateText(String(row?.template ?? ""));
  }
  return out;
}

export async function patchPlatformTextTemplates(
  deps: { prisma: PrismaDeps },
  patch: Record<string, string | null>,
): Promise<void> {
  const platformDelegate = (deps.prisma as any).platformTextTemplate;
  if (!platformDelegate) throw new Error("platformTextTemplate delegate missing");

  for (const [rawKey, rawTemplate] of Object.entries(patch ?? {})) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    if (rawTemplate === null) {
      await platformDelegate.deleteMany({ where: { key } });
      continue;
    }
    const template = normalizeTemplateText(String(rawTemplate ?? ""));
    if (!template) {
      await platformDelegate.deleteMany({ where: { key } });
      continue;
    }
    await platformDelegate.upsert({
      where: { key },
      create: { key, template },
      update: { template },
    });
  }
}

export async function patchProjectTextTemplates(
  deps: { prisma: PrismaDeps },
  opts: { projectId: string; patch: Record<string, string | null> },
): Promise<void> {
  const projectId = String(opts.projectId ?? "").trim();
  if (!projectId) return;

  const projectDelegate = (deps.prisma as any).projectTextTemplate;
  if (!projectDelegate) throw new Error("projectTextTemplate delegate missing");

  for (const [rawKey, rawTemplate] of Object.entries(opts.patch ?? {})) {
    const key = String(rawKey ?? "").trim();
    if (!key) continue;
    if (rawTemplate === null) {
      await projectDelegate.deleteMany({ where: { projectId, key } as any });
      continue;
    }
    const template = normalizeTemplateText(String(rawTemplate ?? ""));
    if (!template) {
      await projectDelegate.deleteMany({ where: { projectId, key } as any });
      continue;
    }
    await projectDelegate.upsert({
      where: { projectId_key: { projectId, key } } as any,
      create: { id: uuidv7(), projectId, key, template } as any,
      update: { template } as any,
    });
  }
}
