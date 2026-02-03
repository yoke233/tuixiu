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

export type GitAuthMode = "https_pat" | "ssh";

export type Project = {
  id: string;
  name: string;
  repoUrl: string;
  scmType: string;
  defaultBranch: string;
  workspaceMode?: "worktree" | "clone";
  defaultRoleKey?: string | null;
  agentWorkspaceNoticeTemplate?: string | null;
  runGitCredentialId?: string | null;
  scmAdminCredentialId?: string | null;
  hasRunGitCredential?: boolean;
  hasScmAdminCredential?: boolean;
  gitlabProjectId?: number | null;
  githubPollingEnabled?: boolean;
  githubPollingCursor?: string | null;
  createdAt: string;
};

export type GitCredential = {
  id: string;
  projectId: string;
  key: string;
  purpose: string | null;
  gitAuthMode: GitAuthMode;
  hasGithubAccessToken: boolean;
  hasGitlabAccessToken: boolean;
  hasSshKey: boolean;
  updatedAt: string;
};

export type ProjectScmConfig = {
  projectId: string;
  gitlabProjectId: number | null;
  hasGitlabWebhookSecret: boolean;
  githubPollingEnabled: boolean;
  githubPollingCursor: string | null;
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
  labels?: unknown;
  createdAt: string;
  updatedAt?: string;
  externalProvider?: string | null;
  externalId?: string | null;
  externalNumber?: number | null;
  externalUrl?: string | null;
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
  metadata?: unknown;
};

export type AcpSessionActivity =
  | "unknown"
  | "idle"
  | "busy"
  | "loading"
  | "cancel_requested"
  | "closed";

export type AcpSessionState = {
  sessionId: string;
  activity: AcpSessionActivity;
  inFlight: number;
  updatedAt: string;
  currentModeId: string | null;
  currentModelId: string | null;
  lastStopReason: string | null;
  note: string | null;
};

export type AcpSessionSummary = {
  runId: string;
  issueId: string;
  issueTitle: string;
  projectId: string;
  runStatus: RunStatus;
  sessionId: string;
  sessionState: AcpSessionState | null;
  startedAt: string;
  completedAt: string | null;
  agent: { id: string; name: string; proxyId: string; status: AgentStatus } | null;
};

export type TaskStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export type TaskTrack = "quick" | "planning" | "enterprise";

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
  track?: TaskTrack | null;
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
export type TaskTemplate = {
  key: string;
  displayName: string;
  description: string;
  track?: TaskTrack | null;
  deprecated?: boolean;
  steps: TaskTemplateStep[];
};

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

export type ApprovalAction = "merge_pr" | "create_pr" | "publish_artifact";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "failed";

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
  lastHeartbeat?: string | null;
  healthCheckInterval?: number;
  stats?: unknown;
  createdAt: string;
  updatedAt?: string;
};

export type SandboxStatus = "creating" | "running" | "stopped" | "missing" | "error";

export type SandboxSummary = {
  proxyId: string;
  runId: string | null;
  instanceName: string;
  provider: string | null;
  runtime: string | null;
  sandboxStatus: SandboxStatus | null;
  sandboxLastSeenAt: string | null;
  keepaliveTtlSeconds: number | null;
  issueId: string | null;
  taskId: string | null;
  stepId: string | null;
  sandboxLastError: string | null;
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
  agentInputs?: AgentInputsManifestV1 | null;
  envKeys?: string[];
  envText?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentInputsTargetRoot = "WORKSPACE" | "USER_HOME";
export type AgentInputsApply = "bindMount" | "downloadExtract" | "writeFile" | "copy";
export type AgentInputsAccess = "ro" | "rw";

export type AgentInputsEnvPatch = Partial<Record<"HOME" | "USER" | "LOGNAME", string>>;

export type AgentInputItem = {
  id: string;
  name?: string;
  apply: AgentInputsApply;
  access?: AgentInputsAccess;
  source:
    | { type: "hostPath"; path: string }
    | { type: "httpZip"; uri: string; contentHash?: string }
    | { type: "inlineText"; text: string };
  target: { root: AgentInputsTargetRoot; path: string };
};

export type AgentInputsManifestV1 = {
  version: 1;
  envPatch?: AgentInputsEnvPatch;
  items: AgentInputItem[];
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
  recommendedTrack?: TaskTrack | null;
};

export type PmAnalysisMeta = {
  source: "llm" | "fallback";
  model?: string;
};

export type PmNextActionSource = "approval" | "task" | "auto_review" | "issue" | "fallback";

export type PmNextAction = {
  issueId: string;
  action: string;
  reason: string;
  source: PmNextActionSource;
  taskId: string | null;
  step: {
    id: string;
    key: string;
    kind: string;
    status: StepStatus;
    executorType: ExecutorType;
  } | null;
  run: { id: string; status: RunStatus } | null;
  approval: Approval | null;
};

export type PmPolicy = {
  version: 1;
  automation: {
    autoStartIssue: boolean;
    autoReview: boolean;
    autoCreatePr: boolean;
    autoRequestMergeApproval: boolean;
  };
  approvals: {
    requireForActions: ApprovalAction[];
    escalateOnSensitivePaths: ApprovalAction[];
  };
  sensitivePaths: string[];
};
