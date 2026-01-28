import type { TaskTemplate, TaskTrack } from "../../types";

const TASK_TEMPLATE_PRIORITY_ANY: string[] = [
  "quick.dev.full",
  "planning.prd.dev.full",
  "planning.prd.only",
  "quick.test.only",
  "quick.admin.session",
  "enterprise.dev.full",
];

const TASK_TEMPLATE_PRIORITY_BY_TRACK: Record<TaskTrack, string[]> = {
  quick: ["quick.dev.full", "quick.test.only", "quick.admin.session"],
  planning: ["planning.prd.dev.full", "planning.prd.only"],
  enterprise: ["enterprise.dev.full", "quick.dev.full"],
};

export function pickTemplateKey(opts: { templates: TaskTemplate[]; track: TaskTrack | ""; currentKey: string }): string {
  const selectable = opts.templates.filter((t) => !t.deprecated);
  if (!selectable.length) return "";

  const candidates = opts.track ? selectable.filter((t) => !t.track || t.track === opts.track) : selectable;
  if (!candidates.length) return "";

  const current = opts.currentKey ? candidates.find((t) => t.key === opts.currentKey) ?? null : null;
  if (current) return current.key;

  const priority = opts.track ? TASK_TEMPLATE_PRIORITY_BY_TRACK[opts.track] ?? TASK_TEMPLATE_PRIORITY_ANY : TASK_TEMPLATE_PRIORITY_ANY;
  for (const key of priority) {
    if (candidates.some((t) => t.key === key)) return key;
  }
  return candidates[0]?.key ?? "";
}

export function sortTemplatesByPriority(track: TaskTrack, templates: TaskTemplate[]): TaskTemplate[] {
  const priority = TASK_TEMPLATE_PRIORITY_BY_TRACK[track] ?? [];
  const rank = new Map<string, number>(priority.map((k, idx) => [k, idx]));
  return [...templates].sort((a, b) => {
    const ra = rank.get(a.key) ?? 999;
    const rb = rank.get(b.key) ?? 999;
    if (ra !== rb) return ra - rb;
    return String(a.displayName ?? "").localeCompare(String(b.displayName ?? ""), "zh-CN");
  });
}

