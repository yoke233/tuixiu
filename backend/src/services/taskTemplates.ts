export type TaskTemplateStep = {
  key: string;
  kind: string;
  executorType: "agent" | "ci" | "human" | "system";
  roleKey?: string;
  params?: Record<string, unknown>;
};

export type TaskTemplate = {
  key: string;
  displayName: string;
  description?: string;
  steps: TaskTemplateStep[];
};

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "template.dev.full",
    displayName: "开发全流程（实现→测试→评审→PR→CI→合并）",
    steps: [
      { key: "dev.implement", kind: "dev.implement", executorType: "agent" },
      { key: "test.run", kind: "test.run", executorType: "agent", params: { mode: "dual" } },
      { key: "code.review.ai", kind: "code.review", executorType: "agent", params: { mode: "ai" } },
      { key: "code.review.human", kind: "code.review", executorType: "human", params: { mode: "human" } },
      { key: "pr.create", kind: "pr.create", executorType: "system" },
      { key: "ci.gate", kind: "ci.gate", executorType: "ci" },
      { key: "merge", kind: "pr.merge", executorType: "human" },
    ],
  },
  {
    key: "template.prd.only",
    displayName: "PRD（生成→评审→发布）",
    steps: [
      { key: "prd.generate", kind: "prd.generate", executorType: "agent" },
      { key: "prd.review", kind: "prd.review", executorType: "human" },
      { key: "prd.publish", kind: "report.publish", executorType: "system", params: { kind: "prd" } },
    ],
  },
  {
    key: "template.test.only",
    displayName: "测试（运行→发布）",
    steps: [
      { key: "test.run", kind: "test.run", executorType: "agent", params: { mode: "dual" } },
      { key: "test.publish", kind: "report.publish", executorType: "system", params: { kind: "test" } },
    ],
  },
];

export function getTaskTemplate(key: string): TaskTemplate | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  return TASK_TEMPLATES.find((t) => t.key === k) ?? null;
}

