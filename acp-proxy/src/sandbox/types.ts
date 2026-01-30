export type ProcessHandle = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
  onExit?: (cb: (info: { code: number | null; signal: string | null }) => void) => void;
};

export type RunProcessOpts = { command: string[]; cwd: string; env?: Record<string, string> };

export interface SandboxProvider {
  runProcess(opts: RunProcessOpts): Promise<ProcessHandle>;
}

export type SandboxProviderKind = "boxlite_oci" | "container_oci" | "host_process";

export type SandboxInstanceState = "running" | "stopped" | "missing";

export type SandboxInstanceInfo = {
  instanceName: string;
  status: SandboxInstanceState;
  createdAt: string | null;
};

export type WorkspaceMount = {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
};

export type EnsureInstanceRunningOpts = {
  runId: string;
  instanceName: string;
  workspaceGuestPath: string;
  env?: Record<string, string>;
  mounts?: WorkspaceMount[];
};

export type ExecProcessInInstanceOpts = {
  instanceName: string;
  command: string[];
  cwdInGuest: string;
  env?: Record<string, string>;
};

export type ListInstancesOpts = {
  managedOnly?: boolean;
  namePrefix?: string;
};

export interface SandboxInstanceProvider {
  readonly provider: SandboxProviderKind;
  readonly runtime?: string | undefined;

  inspectInstance(instanceName: string): Promise<SandboxInstanceInfo>;
  ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo>;
  stopInstance(instanceName: string): Promise<void>;
  removeInstance(instanceName: string): Promise<void>;
  removeImage(image: string): Promise<void>;
  execProcess(opts: ExecProcessInInstanceOpts): Promise<ProcessHandle>;
  listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]>;
}
