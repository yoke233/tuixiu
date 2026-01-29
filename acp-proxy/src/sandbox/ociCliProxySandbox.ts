import type { LoadedProxyConfig } from "../config.js";
import { ContainerSandbox } from "./containerSandbox.js";
import type { ContainerCli } from "./cliRuntime.js";
import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
} from "./types.js";

import type { ProxySandbox } from "./ProxySandbox.js";
import { parseContainerCli, startContainerOciCliAgent } from "./containerOciCliAgent.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type ContainerSandboxApi = {
  inspectInstance(instanceName: string): Promise<SandboxInstanceInfo>;
  listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]>;
  ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo>;
  stopInstance(instanceName: string): Promise<void>;
  removeInstance(instanceName: string): Promise<void>;
  removeImage(image: string): Promise<void>;
  execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle>;
  attachInstance(instanceName: string): Promise<ProcessHandle>;
  startAndAttachInstance(instanceName: string): Promise<ProcessHandle>;
  getInstanceLabels(instanceName: string): Promise<Record<string, string>>;
};

type StartAgentFn = (opts: {
  cli: ContainerCli;
  name: string;
  image: string;
  workingDir: string;
  mounts?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  extraArgs?: string[];
  autoRemove?: boolean;
  initMarkerPrefix: string;
  initScript?: string;
  initEnv?: Record<string, string>;
  agentCommand: string[];
}) => ProcessHandle;

type ContainerOciSandboxCfg = LoadedProxyConfig["sandbox"] & {
  provider: "container_oci";
  runtime: string;
};

export const DEFAULT_INIT_MARKER_PREFIX = "__ACP_PROXY_INIT_RESULT__:";

function toMounts(volumes: ContainerOciSandboxCfg["volumes"] | undefined): string[] {
  return (volumes ?? []).map((v) => {
    const suffix = v.readOnly ? ":ro" : "";
    return `${v.hostPath}:${v.guestPath}${suffix}`;
  });
}

function toExtraArgs(cfg: ContainerOciSandboxCfg): string[] {
  const out: string[] = [...(cfg.extraRunArgs ?? [])];
  if (typeof cfg.cpus === "number") out.push("--cpus", String(cfg.cpus));
  if (typeof cfg.memoryMib === "number") out.push("--memory", `${cfg.memoryMib}m`);
  return out;
}

export class OciCliProxySandbox implements ProxySandbox {
  readonly provider = "container_oci" as const;
  readonly runtime: string | null;
  readonly agentMode = "entrypoint" as const;

  private readonly container: ContainerSandboxApi;
  private readonly startAgent: StartAgentFn;

  constructor(
    private readonly opts: { config: ContainerOciSandboxCfg; log: Logger } & {
      container?: ContainerSandboxApi;
      startAgent?: StartAgentFn;
    },
  ) {
    this.runtime = opts.config.runtime?.trim() ? opts.config.runtime.trim() : null;
    this.container =
      opts.container ??
      new ContainerSandbox({
        log: opts.log,
        config: {
          runtime: opts.config.runtime,
          image: opts.config.image,
          workingDir: opts.config.workingDir,
          volumes: opts.config.volumes,
          env: opts.config.env,
          cpus: opts.config.cpus,
          memoryMib: opts.config.memoryMib,
          extraRunArgs: opts.config.extraRunArgs,
        },
      });
    this.startAgent = opts.startAgent ?? startContainerOciCliAgent;
  }

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    return await this.container.inspectInstance(instanceName);
  }

  async ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo> {
    return await this.container.ensureInstanceRunning(opts);
  }

  async listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]> {
    return await this.container.listInstances(opts);
  }

  async stopInstance(instanceName: string): Promise<void> {
    await this.container.stopInstance(instanceName);
  }

  async removeInstance(instanceName: string): Promise<void> {
    await this.container.removeInstance(instanceName);
  }

  async removeImage(image: string): Promise<void> {
    await this.container.removeImage(image);
  }

  async execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle> {
    return await this.container.execProcess(opts);
  }

  async openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    agentCommand: string[];
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
  }): Promise<{ handle: ProcessHandle; created: boolean; initPending: boolean }> {
    const initScript = opts.init?.script?.trim() ?? "";
    const initEnv =
      opts.init?.env && typeof opts.init.env === "object" && !Array.isArray(opts.init.env)
        ? { ...(opts.init.env as Record<string, string>) }
        : undefined;

    let before = await this.container.inspectInstance(opts.instanceName);

    if (initScript && before.status !== "missing") {
      await this.container.removeInstance(opts.instanceName).catch(() => {});
      before = { instanceName: opts.instanceName, status: "missing", createdAt: null };
    }

    if (before.status !== "missing") {
      const labels = await this.container.getInstanceLabels(opts.instanceName);
      const agentModeLabel = labels["acp-proxy.agent_mode"] ?? "";
      if (agentModeLabel && agentModeLabel !== "entrypoint") {
        throw new Error(
          `发现既有容器但不是 entrypoint 模式（acp-proxy.agent_mode=${JSON.stringify(agentModeLabel)}）。请先 remove sandbox 实例（instance_name=${opts.instanceName}）后重试。`,
        );
      }
    }

    if (before.status === "missing") {
      const cli = parseContainerCli(this.opts.config.runtime ?? "docker");
      const workingDir = this.opts.config.workingDir?.trim()
        ? this.opts.config.workingDir.trim()
        : opts.workspaceGuestPath.trim()
          ? opts.workspaceGuestPath.trim()
          : "/workspace";

      const handle = this.startAgent({
        cli,
        name: opts.instanceName,
        image: this.opts.config.image,
        workingDir,
        mounts: toMounts(this.opts.config.volumes),
        env: this.opts.config.env,
        labels: {
          "acp-proxy.managed": "1",
          "acp-proxy.agent_mode": "entrypoint",
          ...(opts.runId.trim() ? { "acp-proxy.run_id": opts.runId.trim() } : {}),
        },
        extraArgs: toExtraArgs(this.opts.config),
        autoRemove: false,
        initMarkerPrefix: DEFAULT_INIT_MARKER_PREFIX,
        initScript,
        initEnv,
        agentCommand: opts.agentCommand,
      });

      return { handle, created: true, initPending: !!initScript };
    }

    const handle =
      before.status === "stopped"
        ? await this.container.startAndAttachInstance(opts.instanceName)
        : await this.container.attachInstance(opts.instanceName);

    return { handle, created: false, initPending: false };
  }
}
