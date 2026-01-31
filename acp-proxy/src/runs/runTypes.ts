export type RunRuntime = {
  runId: string;
  instanceName: string;
  keepaliveTtlSeconds: number;
  expiresAt: number | null;
  lastUsedAt: number;
  opQueue: Promise<void>;
  hostWorkspacePath?: string | null;
  hostWorkspaceReady?: boolean;
  workspaceMounts?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;

  agent: import("../acp/agentBridge.js").AgentBridge | null;
  suppressNextAcpExit: boolean;
  acpClient: import("../acpClientFacade.js").AcpClientFacade | null;
  initialized: boolean;
  initResult: unknown | null;
  seenSessionIds: Set<string>;
  activePromptId: string | null;

  // 用于避免对同一个 session 反复发送 set_config_option（例如 mode=auto）。
  autoConfigOptionAppliedSessionIds?: Set<string>;

  // runtime skills mounting
  skillsCodexHomeHostPath?: string | null;
};
