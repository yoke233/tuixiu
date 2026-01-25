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

export type ArtifactType = "branch" | "mr" | "patch" | "report" | "ci_result";

export type Artifact = {
  id: string;
  runId: string;
  type: ArtifactType;
  content: unknown;
  createdAt: string;
};

