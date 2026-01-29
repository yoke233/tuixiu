import type { LoadedProxyConfig } from "../../config.js";
import { BoxliteSandbox } from "../../sandbox/boxliteSandbox.js";
import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
} from "../../sandbox/types.js";

import type { ProxySandbox } from "./ProxySandbox.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type BoxliteSandboxApi = {
  inspectInstance(instanceName: string): Promise<SandboxInstanceInfo>;
  listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]>;
  ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo>;
  stopInstance(instanceName: string): Promise<void>;
  removeInstance(instanceName: string): Promise<void>;
  execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle>;
};

type BoxliteSandboxCfg = LoadedProxyConfig["sandbox"] & { provider: "boxlite_oci" };

export class BoxliteProxySandbox implements ProxySandbox {
  readonly provider = "boxlite_oci" as const;
  readonly runtime = null;
  readonly agentMode = "exec" as const;

  private readonly boxlite: BoxliteSandboxApi;

  constructor(
    private readonly opts: { config: BoxliteSandboxCfg; log: Logger } & {
      boxlite?: BoxliteSandboxApi;
    },
  ) {
    this.boxlite =
      opts.boxlite ??
      new BoxliteSandbox({
        log: opts.log,
        config: {
          image: opts.config.image,
          workingDir: opts.config.workingDir,
          volumes: opts.config.volumes,
          env: opts.config.env,
          cpus: opts.config.cpus,
          memoryMib: opts.config.memoryMib,
        },
      });
  }

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    return await this.boxlite.inspectInstance(instanceName);
  }

  async ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo> {
    return await this.boxlite.ensureInstanceRunning(opts);
  }

  async listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]> {
    return await this.boxlite.listInstances(opts);
  }

  async stopInstance(instanceName: string): Promise<void> {
    await this.boxlite.stopInstance(instanceName);
  }

  async removeInstance(instanceName: string): Promise<void> {
    await this.boxlite.removeInstance(instanceName);
  }

  async execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle> {
    return await this.boxlite.execProcess(opts);
  }

  async openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    agentCommand: string[];
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
  }): Promise<{ handle: ProcessHandle; created: boolean; initPending: boolean }> {
    const before = await this.boxlite.inspectInstance(opts.instanceName);
    const created = before.status === "missing";
    if (created) {
      await this.boxlite.ensureInstanceRunning({
        runId: opts.runId,
        instanceName: opts.instanceName,
        workspaceGuestPath: opts.workspaceGuestPath,
        env: undefined,
      });
    }

    const handle = await this.boxlite.execProcess({
      instanceName: opts.instanceName,
      command: opts.agentCommand,
      cwdInGuest: opts.workspaceGuestPath,
      env: undefined,
    });

    return { handle, created, initPending: false };
  }
}
