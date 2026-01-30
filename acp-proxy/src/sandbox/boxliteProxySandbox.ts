import { setTimeout as delay } from "node:timers/promises";

import type { LoadedProxyConfig } from "../config.js";
import { BoxliteSandbox } from "./boxliteSandbox.js";
import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
} from "./types.js";

import type { ProxySandbox } from "./ProxySandbox.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type BoxliteSandboxApi = {
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
};

type BoxliteSandboxCfg = LoadedProxyConfig["sandbox"] & { provider: "boxlite_oci"; image: string };

export class BoxliteProxySandbox implements ProxySandbox {
  readonly provider = "boxlite_oci" as const;
  readonly runtime = null;
  readonly agentMode = "exec" as const;

  private readonly boxlite: BoxliteSandboxApi;
  private readonly bootstrapped = new Set<string>();
  private reportBootstrap:
    | ((info: { runId: string; stage: string; status: string; message?: string }) => void)
    | null = null;

  constructor(
    private readonly opts: { config: BoxliteSandboxCfg; log: Logger } & {
      boxlite?: BoxliteSandboxApi;
    },
  ) {
    this.opts.log("boxlite proxy sandbox init", {
      image: opts.config.image,
      workingDir: opts.config.workingDir ?? "/workspace",
    });
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
          boxMode: opts.config.boxMode,
          boxName: opts.config.boxName,
          boxReuse: opts.config.boxReuse,
          boxAutoRemove: opts.config.boxAutoRemove,
          execTimeoutSeconds: opts.config.execTimeoutSeconds,
          execLogIntervalSeconds: opts.config.execLogIntervalSeconds,
        },
      });
  }

  setBootstrapReporter(
    fn: ((info: { runId: string; stage: string; status: string; message?: string }) => void) | null,
  ): void {
    this.reportBootstrap = fn;
  }

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    return await this.boxlite.inspectInstance(instanceName);
  }

  async ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo> {
    this.opts.log("boxlite proxy ensureInstanceRunning", {
      instanceName: opts.instanceName,
      runId: opts.runId,
    });
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

  async removeImage(image: string): Promise<void> {
    await this.boxlite.removeImage(image);
  }

  async execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle> {
    this.opts.log("boxlite proxy execProcess", {
      instanceName: opts.instanceName,
      cmd: opts.command[0],
      args: opts.command.slice(1),
      cwd: opts.cwdInGuest,
    });
    return await this.boxlite.execProcess(opts);
  }

  async openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
    agentCommand: string[];
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
  }): Promise<{ handle: ProcessHandle; created: boolean; initPending: boolean }> {
    this.opts.log("boxlite proxy openAgent", {
      runId: opts.runId,
      instanceName: opts.instanceName,
      workspace: opts.workspaceGuestPath,
      cmd: opts.agentCommand[0],
    });
    const before = await this.boxlite.inspectInstance(opts.instanceName);
    const created = before.status === "missing";
    if (created) {
      this.opts.log("boxlite proxy create instance", { instanceName: opts.instanceName });
      await this.boxlite.ensureInstanceRunning({
        runId: opts.runId,
        instanceName: opts.instanceName,
        workspaceGuestPath: opts.workspaceGuestPath,
        env: undefined,
        mounts: opts.mounts,
      });
    }

    await this.ensureBootstrap(opts.runId, opts.instanceName, opts.workspaceGuestPath);

    this.opts.log("boxlite proxy start agent", {
      instanceName: opts.instanceName,
      cmd: opts.agentCommand[0],
    });
    const handle = await this.boxlite.execProcess({
      instanceName: opts.instanceName,
      command: opts.agentCommand,
      cwdInGuest: opts.workspaceGuestPath,
      env: undefined,
    });

    return { handle, created, initPending: false };
  }

  private async ensureBootstrap(
    runId: string,
    instanceName: string,
    cwdInGuest: string,
  ): Promise<void> {
    const bootstrap = this.opts.config.bootstrap;
    if (!bootstrap) return;
    const bootstrapKey = this.getBootstrapKey(instanceName);
    if (this.bootstrapped.has(bootstrapKey)) return;

    const timeoutSeconds = bootstrap.timeoutSeconds ?? 600;
    const checkCommand = bootstrap.checkCommand;
    const installCommand = bootstrap.installCommand;

    this.reportBootstrap?.({ runId, stage: "bootstrap", status: "start" });
    if (checkCommand?.length) {
      this.reportBootstrap?.({ runId, stage: "bootstrap_check", status: "start" });
      this.opts.log("boxlite bootstrap check", { instanceName, cmd: checkCommand[0] });
      let res: { code: number | null; signal: string | null };
      try {
        res = await this.runCommand({
          instanceName,
          command: checkCommand,
          cwdInGuest,
          timeoutSeconds,
          label: "bootstrap:check",
        });
      } catch (err) {
        const message = String(err);
        this.reportBootstrap?.({
          runId,
          stage: "bootstrap_check",
          status: "failed",
          message,
        });
        this.reportBootstrap?.({ runId, stage: "bootstrap", status: "failed", message });
        throw err;
      }
      this.opts.log("boxlite bootstrap check exit", {
        instanceName,
        exitCode: res.code,
        signal: res.signal,
      });
      this.reportBootstrap?.({
        runId,
        stage: "bootstrap_check",
        status: res.code === 0 ? "done" : "failed",
      });
      if (res.code === 0) {
        this.opts.log("boxlite bootstrap already satisfied", { instanceName });
        this.bootstrapped.add(bootstrapKey);
        this.reportBootstrap?.({ runId, stage: "bootstrap", status: "skip", message: "cached" });
        return;
      }
      this.opts.log("boxlite bootstrap check failed; will install", {
        instanceName,
        exitCode: res.code,
      });
    }

    if (!installCommand?.length) {
      this.opts.log("boxlite bootstrap skipped (no installCommand)", { instanceName });
      this.bootstrapped.add(bootstrapKey);
      this.reportBootstrap?.({ runId, stage: "bootstrap", status: "skip", message: "no-install" });
      return;
    }

    this.opts.log("boxlite bootstrap install start", {
      instanceName,
      cmd: installCommand[0],
    });
    this.reportBootstrap?.({ runId, stage: "bootstrap_install", status: "start" });
    let res: { code: number | null; signal: string | null };
    try {
      res = await this.runCommand({
        instanceName,
        command: installCommand,
        cwdInGuest,
        timeoutSeconds,
        label: "bootstrap:install",
      });
    } catch (err) {
      const message = String(err);
      this.reportBootstrap?.({
        runId,
        stage: "bootstrap_install",
        status: "failed",
        message,
      });
      this.reportBootstrap?.({ runId, stage: "bootstrap", status: "failed", message });
      throw err;
    }
    if (res.code !== 0) {
      this.reportBootstrap?.({ runId, stage: "bootstrap_install", status: "failed" });
      throw new Error(`boxlite bootstrap failed (exitCode=${res.code ?? "null"})`);
    }
    this.opts.log("boxlite bootstrap install done", { instanceName });
    this.bootstrapped.add(bootstrapKey);
    this.reportBootstrap?.({ runId, stage: "bootstrap_install", status: "done" });
    this.reportBootstrap?.({ runId, stage: "bootstrap", status: "done" });
  }

  private getBootstrapKey(instanceName: string): string {
    const boxName = this.opts.config.boxName?.trim();
    if (this.opts.config.boxMode === "jsbox" && this.opts.config.boxReuse === "shared" && boxName) {
      return `box:${boxName}`;
    }
    return `instance:${instanceName}`;
  }

  private async runCommand(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    timeoutSeconds: number;
    label: string;
  }): Promise<{ code: number | null; signal: string | null }> {
    const proc = await this.boxlite.execProcess({
      instanceName: opts.instanceName,
      command: opts.command,
      cwdInGuest: opts.cwdInGuest,
      env: undefined,
    });

    const readLines = async (stream: ReadableStream<Uint8Array> | undefined, kind: string) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split(/\r?\n/g);
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const text = line.trim();
            if (!text) continue;
            this.opts.log(`boxlite ${opts.label} ${kind}`, { line: text });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        const rest = buf.trim();
        if (rest) {
          this.opts.log(`boxlite ${opts.label} ${kind}`, { line: rest });
        }
      }
    };

    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      if (!proc.onExit) return resolve({ code: null, signal: null });
      proc.onExit((info) => resolve(info));
    });

    const outP = readLines(proc.stdout, "stdout");
    const errP = readLines(proc.stderr, "stderr");

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      delay(opts.timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raced.kind === "timeout") {
      this.opts.log("boxlite command timeout", {
        label: opts.label,
        instanceName: opts.instanceName,
        timeoutSeconds: opts.timeoutSeconds,
      });
      await proc.close().catch(() => {});
      await Promise.allSettled([outP, errP]);
      throw new Error(`boxlite command timeout: ${opts.label}`);
    }

    await Promise.allSettled([outP, errP]);
    return { code: raced.code, signal: raced.signal };
  }
}
