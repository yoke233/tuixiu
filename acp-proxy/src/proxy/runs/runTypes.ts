export type RunRuntime = {
  runId: string;
  instanceName: string;
  keepaliveTtlSeconds: number;
  expiresAt: number | null;
  lastUsedAt: number;
  opQueue: Promise<void>;

  agent: import("../acp/agentBridge.js").AgentBridge | null;
  suppressNextAcpExit: boolean;
  acpClient: import("../../acpClientFacade.js").AcpClientFacade | null;
  initialized: boolean;
  initResult: unknown | null;
  seenSessionIds: Set<string>;
  activePromptId: string | null;
};
