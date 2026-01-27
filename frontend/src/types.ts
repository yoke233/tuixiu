export type ApiError = {
  code: string;
  message: string;
  details?: string;
};

export type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError; data?: unknown };

export type UserRole = "admin" | "pm" | "reviewer" | "dev";

export type User = {
  id: string;
  username: string;
  role: UserRole;
};

export type Project = {
  id: string;
  name: string;
  repoUrl: string;
  scmType: string;
  defaultBranch: string;
  workspaceMode?: "worktree" | "clone";
  gitAuthMode?: "https_pat" | "ssh";
  defaultRoleKey?: string | null;
  createdAt: string;
};

export type IssueStatus = "pending" | "running" | "reviewing" | "done" | "failed" | "cancelled";

export type Issue = {
  id: string;
  projectId: string;
  project?: Project;
  title: string;
  description?: string | null;
  status: IssueStatus;
  archivedAt?: string | null;
  createdAt: string;
  runs: Run[];
};

export type RunStatus = "pending" | "running" | "waiting_ci" | "completed" | "failed" | "cancelled";

export type ExecutorType = "agent" | "ci" | "human" | "system";

export type Run = {
  id: string;
  issueId: string;
  agentId: string | null;
  executorType: ExecutorType;
  taskId?: string | null;
  stepId?: string | null;
  attempt?: number;
  acpSessionId?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  status: RunStatus;
  startedAt: string;
  completedAt?: string | null;
  artifacts?: Artifact[];
};

export type TaskStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export type StepStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_ci"
  | "waiting_human"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type Step = {
  id: string;
  taskId: string;
  key: string;
  kind: string;
  order: number;
  status: StepStatus;
  executorType: ExecutorType;
  roleKey?: string | null;
  params?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  issueId: string;
  templateKey: string;
  status: TaskStatus;
  currentStepId?: string | null;
  workspaceType?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  baseBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
  runs?: Run[];
};

export type TaskTemplateStep = { key: string; kind: string; executorType: ExecutorType };
export type TaskTemplate = { key: string; displayName: string; description: string; steps: TaskTemplateStep[] };

export type EventSource = "acp" | "gitlab" | "system" | "user";

export type Event = {
  id: string;
  runId: string;
  source: EventSource;
  type: string;
  payload?: unknown;
  timestamp: string;
};

export type ArtifactType = "branch" | "pr" | "patch" | "report" | "ci_result";

export type Artifact = {
  id: string;
  runId: string;
  type: ArtifactType;
  content: unknown;
  createdAt: string;
};

export type ApprovalAction = "merge_pr";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executing" | "executed" | "failed";

export type Approval = {
  id: string;
  runId: string;
  createdAt: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  issueId?: string | null;
  issueTitle?: string | null;
  projectId?: string | null;
};

export type AgentStatus = "online" | "offline" | "degraded" | "suspended";

export type Agent = {
  id: string;
  name: string;
  type?: string;
  proxyId: string;
  status: AgentStatus;
  capabilities?: unknown;
  currentLoad: number;
  maxConcurrentRuns: number;
  createdAt: string;
};

export type RoleTemplate = {
  id: string;
  projectId: string;
  key: string;
  displayName: string;
  description?: string | null;
  promptTemplate?: string | null;
  initScript?: string | null;
  initTimeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
};

export type GitHubIssue = {
  id: string;
  number: number;
  title: string;
  state: string;
  url: string;
  labels: unknown[];
  updatedAt?: string | null;
};

export type PmRisk = "low" | "medium" | "high";

export type PmAnalysis = {
  summary: string;
  risk: PmRisk;
  questions: string[];
  recommendedRoleKey?: string | null;
  recommendedAgentId?: string | null;
};

export type PmAnalysisMeta = {
  source: "llm" | "fallback";
  model?: string;
};

export type PmPolicy = {
  version: 1;
  automation: {
    autoStartIssue: boolean;
  };
  approvals: {
    requireForActions: ApprovalAction[];
  };
  sensitivePaths: string[];
};
