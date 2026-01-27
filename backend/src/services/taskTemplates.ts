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

export const TASK_TEMPLATES: TaskTemplate[] = [
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
    key: "template.admin.session",
    displayName: "管理员会话（交互式 Session）",
    description: "（legacy）创建一个独立分支/worktree，用于与 Agent 像 CLI 一样持续对话协作（不依赖 Issue 流程）",
    track: "quick",
    deprecated: true,
    steps: ADMIN_SESSION_STEPS,
  },
  {
    key: "template.dev.full",
    displayName: "开发全流程（实现→测试→评审→PR→CI→合并）",
    description: "（legacy）推荐改用 quick.dev.full",
    track: "quick",
    deprecated: true,
    steps: DEV_FULL_STEPS,
  },
  {
    key: "template.prd.only",
    displayName: "PRD（生成→评审→发布）",
    description: "（legacy）推荐改用 planning.prd.only",
    track: "planning",
    deprecated: true,
    steps: PRD_ONLY_STEPS,
  },
  {
    key: "template.test.only",
    displayName: "测试（运行→发布）",
    description: "（legacy）推荐改用 quick.test.only",
    track: "quick",
    deprecated: true,
    steps: TEST_ONLY_STEPS,
  },
];

export function getTaskTemplate(key: string): TaskTemplate | null {
  const k = String(key ?? "").trim();
  if (!k) return null;
  return TASK_TEMPLATES.find((t) => t.key === k) ?? null;
}

