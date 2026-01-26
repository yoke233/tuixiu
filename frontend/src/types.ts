export type ApiError = {
  code: string;
  message: string;
  details?: string;
};

export type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError; data?: unknown };

export type Project = {
  id: string;
  name: string;
  repoUrl: string;
  scmType: string;
  defaultBranch: string;
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
  createdAt: string;
  runs: Run[];
};

export type RunStatus = "pending" | "running" | "waiting_ci" | "completed" | "failed" | "cancelled";

export type Run = {
  id: string;
  issueId: string;
  agentId: string;
  acpSessionId?: string | null;
  workspacePath?: string | null;
  branchName?: string | null;
  status: RunStatus;
  startedAt: string;
  completedAt?: string | null;
  artifacts?: Artifact[];
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

export type AgentStatus = "online" | "offline" | "degraded" | "suspended";

export type Agent = {
  id: string;
  name: string;
  proxyId: string;
  status: AgentStatus;
  currentLoad: number;
  maxConcurrentRuns: number;
  createdAt: string;
};
