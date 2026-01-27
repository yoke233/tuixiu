export type TaskTemplateStep = {
  key: string;
  kind: string;
  executorType: "agent" | "ci" | "human" | "system";
  roleKey?: string;
  params?: Record<string, unknown>;
};

export type TaskTrack = "quick" | "planning" | "enterprise";

export type TaskTemplate = {
  key: string;
  displayName: string;
  description?: string;
  track?: TaskTrack;
  deprecated?: boolean;
  aliasOf?: string;
  steps: TaskTemplateStep[];
};

const ADMIN_SESSION_STEPS: TaskTemplateStep[] = [{ key: "session.interactive", kind: "session.interactive", executorType: "agent" }];

const DEV_FULL_STEPS: TaskTemplateStep[] = [
  { key: "dev.implement", kind: "dev.implement", executorType: "agent" },
  { key: "test.run", kind: "test.run", executorType: "agent", params: { mode: "dual" } },
  { key: "code.review.ai", kind: "code.review", executorType: "agent", params: { mode: "ai" } },
  { key: "code.review.human", kind: "code.review", executorType: "human", params: { mode: "human" } },
  { key: "pr.create", kind: "pr.create", executorType: "system" },
  { key: "ci.gate", kind: "ci.gate", executorType: "ci" },
  { key: "merge", kind: "pr.merge", executorType: "human" },
];

const PRD_ONLY_STEPS: TaskTemplateStep[] = [
  { key: "prd.generate", kind: "prd.generate", executorType: "agent" },
  { key: "prd.review", kind: "prd.review", executorType: "human" },
  { key: "prd.publish", kind: "report.publish", executorType: "system", params: { kind: "prd" } },
];

const TEST_ONLY_STEPS: TaskTemplateStep[] = [
  { key: "test.run", kind: "test.run", executorType: "agent", params: { mode: "dual" } },
  { key: "test.publish", kind: "report.publish", executorType: "system", params: { kind: "test" } },
];

export const TASK_TEMPLATE_ALIASES: Record<string, string> = {
  "template.admin.session": "quick.admin.session",
  "template.dev.full": "quick.dev.full",
  "template.prd.only": "planning.prd.only",
  "template.test.only": "quick.test.only",
};

export function resolveTaskTemplateKey(key: string): string {
  const k = String(key ?? "").trim();
  if (!k) return "";
  return TASK_TEMPLATE_ALIASES[k] ?? k;
}

const CANONICAL_TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "quick.admin.session",
    displayName: "Quick：管理员会话（交互式 Session）",
    description: "创建一个独立分支/worktree，用于与 Agent 像 CLI 一样持续对话协作（不依赖 Issue 流程）",
    track: "quick",
    steps: ADMIN_SESSION_STEPS,
  },
  {
    key: "quick.dev.full",
    displayName: "Quick：开发全流程（实现→测试→评审→PR→CI→合并）",
    track: "quick",
    steps: DEV_FULL_STEPS,
  },
  {
    key: "planning.prd.dev.full",
    displayName: "Planning：PRD→开发全流程（PRD→实现→测试→评审→PR→CI→合并）",
    description: "会先生成/评审/发布 PRD（提交到当前分支），随后进入开发全流程；PRD 会与后续代码一起进入同一个 PR。",
    track: "planning",
    steps: [...PRD_ONLY_STEPS, ...DEV_FULL_STEPS],
  },
  {
    key: "planning.prd.only",
    displayName: "Planning：PRD（生成→评审→发布）",
    track: "planning",
    steps: PRD_ONLY_STEPS,
  },
  {
    key: "quick.test.only",
    displayName: "Quick：测试（运行→发布）",
    track: "quick",
    steps: TEST_ONLY_STEPS,
  },
  {
    key: "enterprise.dev.full",
    displayName: "Enterprise：开发全流程（更强门禁/审计预留）",
    description: "（预留）与 quick.dev.full 步骤一致，用于需要更强合规/审计策略的任务轨道。",
    track: "enterprise",
    steps: DEV_FULL_STEPS,
  },
];

function getCanonicalTemplateOrThrow(key: string): TaskTemplate {
  const t = CANONICAL_TASK_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`canonical template not found: ${key}`);
  return t;
}

const LEGACY_TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "template.admin.session",
    displayName: "管理员会话（交互式 Session）",
    description: "（legacy，alias → quick.admin.session）创建一个独立分支/worktree，用于与 Agent 像 CLI 一样持续对话协作（不依赖 Issue 流程）",
    deprecated: true,
    aliasOf: "quick.admin.session",
    track: getCanonicalTemplateOrThrow("quick.admin.session").track,
    steps: getCanonicalTemplateOrThrow("quick.admin.session").steps,
  },
  {
    key: "template.dev.full",
    displayName: "开发全流程（实现→测试→评审→PR→CI→合并）",
    description: "（legacy，alias → quick.dev.full）",
    deprecated: true,
    aliasOf: "quick.dev.full",
    track: getCanonicalTemplateOrThrow("quick.dev.full").track,
    steps: getCanonicalTemplateOrThrow("quick.dev.full").steps,
  },
  {
    key: "template.prd.only",
    displayName: "PRD（生成→评审→发布）",
    description: "（legacy，alias → planning.prd.only）",
    deprecated: true,
    aliasOf: "planning.prd.only",
    track: getCanonicalTemplateOrThrow("planning.prd.only").track,
    steps: getCanonicalTemplateOrThrow("planning.prd.only").steps,
  },
  {
    key: "template.test.only",
    displayName: "测试（运行→发布）",
    description: "（legacy，alias → quick.test.only）",
    deprecated: true,
    aliasOf: "quick.test.only",
    track: getCanonicalTemplateOrThrow("quick.test.only").track,
    steps: getCanonicalTemplateOrThrow("quick.test.only").steps,
  },
];

export const TASK_TEMPLATES: TaskTemplate[] = [...CANONICAL_TASK_TEMPLATES, ...LEGACY_TASK_TEMPLATES];

export function getTaskTemplate(key: string): TaskTemplate | null {
  const k = resolveTaskTemplateKey(key);
  if (!k) return null;
  return CANONICAL_TASK_TEMPLATES.find((t) => t.key === k) ?? null;
}

