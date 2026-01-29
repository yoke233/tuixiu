import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
  SandboxProviderKind,
} from "./types.js";

export type AgentInit = {
  script?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
};

export type OpenAgentResult = {
  handle: ProcessHandle;
  created: boolean;
  initPending: boolean;
};

export interface ProxySandbox {
  readonly provider: SandboxProviderKind;
  readonly runtime: string | null;
  readonly agentMode: "entrypoint" | "exec";

  inspectInstance(instanceName: string): Promise<SandboxInstanceInfo>;
  ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo>;
  listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]>;
  stopInstance(instanceName: string): Promise<void>;
  removeInstance(instanceName: string): Promise<void>;
  removeImage(image: string): Promise<void>;
  execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle>;

  openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    agentCommand: string[];
    init?: AgentInit;
  }): Promise<OpenAgentResult>;
}
