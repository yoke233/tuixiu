import { spawn, type ChildProcessWithoutNullStreams, type StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { LoadedProxyConfig } from "../config.js";
import type { ProxySandbox } from "./ProxySandbox.js";
import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
} from "./types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type HostSandboxCfg = LoadedProxyConfig["sandbox"] & { provider: "host_process" };

type HostInstance = {
  instanceName: string;
  runId: string | null;
  workspaceHostPath: string;
  createdAt: string;
  agentProc: ChildProcessWithoutNullStreams | null;
  agentHandle: ProcessHandle | null;
};

const WORKSPACE_GUEST_ROOT = "/workspace";
const PIPE_STDIO = ["pipe", "pipe", "pipe"] as StdioOptions;

function needsCmdShimOnWindows(cmd: string): boolean {
  if (process.platform !== "win32") return false;
  const base = cmd.trim();
  if (!base) return false;
  if (/\s/.test(base)) return true;
  const ext = path.extname(base).toLowerCase();
  // `.cmd`/`.bat` 不能被 CreateProcess 直接当作可执行文件运行；需要走 `cmd.exe /c`。
  if (ext === ".cmd" || ext === ".bat") return true;

  // 没有扩展名时：仅对常见 npm shim 名称走 cmd shim（避免把 node.exe/pwsh.exe 之类也强行包一层）。
  if (ext === "") {
    const name = path.win32.basename(base).toLowerCase();
    const shimNames = new Set(["npm", "npx", "pnpm", "yarn", "bunx", "codex", "codex-acp"]);
    return shimNames.has(name);
  }

  return false;
}

function quoteForCmd(value: string): string {
  // cmd.exe 的简单转义：双引号用 "" 表示
  return `"${value.replaceAll('"', '""')}"`;
}


function buildCmdShimSpawn(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const line =
    command.length === 1
      ? String(command[0] ?? "").trim()
      : [quoteForCmd(command[0] ?? ""), ...command.slice(1).map((a) => quoteForCmd(String(a)))].join(" ");
  return {
    cmd: "cmd.exe",
    args: ["/d", "/s", "/c", line],
    spawnOpts: {
      cwd,
      env,
      stdio: PIPE_STDIO,
      windowsHide: true,
    },
  };
}

function isSubPath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function normalizeGuestPath(requested: string): string {
  const raw = requested.trim();
  if (!raw) throw new Error("cwd is empty");
  const candidate = raw.startsWith("/") ? raw : path.posix.join(WORKSPACE_GUEST_ROOT, raw);
  const normalized = path.posix.normalize(candidate);
  const rootNorm = path.posix.normalize(WORKSPACE_GUEST_ROOT);
  const rootWithSep = rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`;
  if (normalized === rootNorm || normalized.startsWith(rootWithSep)) return normalized;
  throw new Error("cwd outside workspace");
}

function processHandleFromChildProcess(proc: ChildProcessWithoutNullStreams): ProcessHandle {
  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const notifyExit = (info: { code: number | null; signal: string | null }) => {
    for (const cb of exitListeners) cb(info);
  };

  proc.once("exit", (code, signal) => {
    notifyExit({ code: code ?? null, signal: signal ?? null });
  });
  proc.once("error", () => {
    notifyExit({ code: 1, signal: null });
  });

  return {
    stdin: Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>,
    close: async () => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    },
    onExit: (cb) => {
      exitListeners.add(cb);
    },
  };
}

export class HostProcessProxySandbox implements ProxySandbox {
  readonly provider = "host_process" as const;
  readonly runtime = null;
  readonly agentMode = "exec" as const;

  private readonly instances = new Map<string, HostInstance>();

  constructor(private readonly opts: { config: HostSandboxCfg; log: Logger }) {
    this.opts.log("host_process proxy sandbox init", {
      workspaceHostRoot: opts.config.workspaceHostRoot,
    });
  }

  private resolveWorkspaceHostRoot(): string {
    const rootRaw = this.opts.config.workspaceHostRoot?.trim() ?? "";
    if (!rootRaw) throw new Error("sandbox.workspaceHostRoot missing");
    const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
    return path.resolve(root);
  }

  private resolveWorkspaceHostPath(opts: {
    instanceName: string;
    runId?: string;
    mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
  }): string {
    const root = this.resolveWorkspaceHostRoot();
    let hostPath = "";

    if (opts.mounts?.length) {
      const mount = opts.mounts.find((m) => m.guestPath === WORKSPACE_GUEST_ROOT);
      if (mount?.hostPath) hostPath = mount.hostPath;
    }

    if (!hostPath && opts.runId?.trim()) {
      hostPath = path.join(root, `run-${opts.runId.trim()}`);
    }

    if (!hostPath) {
      const existing = this.instances.get(opts.instanceName);
      if (existing?.workspaceHostPath) hostPath = existing.workspaceHostPath;
    }

    if (!hostPath) throw new Error("workspaceHostPath missing");

    const resolved = path.resolve(hostPath);
    if (!isSubPath(root, resolved)) {
      throw new Error("workspaceHostPath outside workspaceHostRoot");
    }
    return resolved;
  }

  private resolveHostCwd(instanceName: string, guestCwd: string): string {
    try {
      const instance = this.instances.get(instanceName);
      if (!instance) throw new Error("instance missing");

      const raw = guestCwd.trim();
      let normalizedGuest = raw;
      let hostPath = "";

      // Windows host_process：允许直接传入宿主机绝对路径（codex-acp 会用 Windows 路径做 cwd / fs / terminal）
      const isWindowsHostAbs =
        /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
      if (process.platform === "win32" && raw && isWindowsHostAbs) {
        normalizedGuest = path.win32.normalize(raw);
        hostPath = path.win32.resolve(normalizedGuest);
      } else {
        normalizedGuest = normalizeGuestPath(raw);
        const relative = path.posix.relative(WORKSPACE_GUEST_ROOT, normalizedGuest);
        hostPath = path.resolve(instance.workspaceHostPath, relative);
      }

      if (!isSubPath(instance.workspaceHostPath, hostPath)) throw new Error("cwd outside workspace");

      this.opts.log("host_process resolveHostCwd", {
        instanceName,
        guestCwd,
        normalizedGuest,
        workspaceHostPath: instance.workspaceHostPath,
        hostCwd: hostPath,
      });

      return hostPath;
    } catch (err) {
      this.opts.log("host_process resolveHostCwd rejected", {
        instanceName,
        guestCwd,
        err: String(err),
      });
      throw err;
    }
  }

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    const instance = this.instances.get(instanceName);
    if (!instance) return { instanceName, status: "missing", createdAt: null };
    return { instanceName, status: "running", createdAt: instance.createdAt };
  }

  async ensureInstanceRunning(opts: EnsureInstanceRunningOpts): Promise<SandboxInstanceInfo> {
    const workspaceHostPath = this.resolveWorkspaceHostPath({
      instanceName: opts.instanceName,
      runId: opts.runId,
      mounts: opts.mounts,
    });
    await mkdir(workspaceHostPath, { recursive: true });

    const existing = this.instances.get(opts.instanceName);
    if (existing) {
      existing.workspaceHostPath = workspaceHostPath;
      return {
        instanceName: opts.instanceName,
        status: "running",
        createdAt: existing.createdAt,
      };
    }

    const createdAt = new Date().toISOString();
    this.instances.set(opts.instanceName, {
      instanceName: opts.instanceName,
      runId: opts.runId?.trim() || null,
      workspaceHostPath,
      createdAt,
      agentProc: null,
      agentHandle: null,
    });
    return { instanceName: opts.instanceName, status: "running", createdAt };
  }

  async listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]> {
    const prefix = opts?.namePrefix?.trim();
    const instances = Array.from(this.instances.values()).filter((inst) =>
      prefix ? inst.instanceName.startsWith(prefix) : true,
    );
    return instances.map((inst) => ({
      instanceName: inst.instanceName,
      status: "running",
      createdAt: inst.createdAt,
    }));
  }

  async stopInstance(instanceName: string): Promise<void> {
    const inst = this.instances.get(instanceName);
    if (!inst) return;
    if (inst.agentHandle) {
      await inst.agentHandle.close().catch(() => {});
    }
    inst.agentProc = null;
    inst.agentHandle = null;
  }

  async removeInstance(instanceName: string): Promise<void> {
    await this.stopInstance(instanceName);
    this.instances.delete(instanceName);
  }

  async removeImage(_image: string): Promise<void> {
    throw new Error("host_process does not support remove_image");
  }

  async execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle> {
    if (!opts.command.length) throw new Error("command is empty");
    const cwd = this.resolveHostCwd(opts.instanceName, opts.cwdInGuest);
    const env = { ...process.env, ...this.opts.config.env, ...opts.env };

    const useCmdShim = needsCmdShimOnWindows(opts.command[0] ?? "");
    const resolved = useCmdShim
      ? buildCmdShimSpawn(opts.command, cwd, env)
      : {
          cmd: opts.command[0],
          args: opts.command.slice(1),
          spawnOpts: {
            cwd,
            env,
            stdio: PIPE_STDIO,
            windowsHide: true,
          },
        };

    this.opts.log("host_process execProcess", {
      instanceName: opts.instanceName,
      cmd: resolved.cmd,
      args: resolved.args,
      cwd,
      shim: useCmdShim ? "cmd.exe" : null,
      rawCmd: opts.command[0],
    });
    try {
      const proc = spawn(resolved.cmd, resolved.args, resolved.spawnOpts) as ChildProcessWithoutNullStreams;
      return processHandleFromChildProcess(proc);
    } catch (err) {
      this.opts.log("host_process spawn failed", {
        instanceName: opts.instanceName,
        cmd: resolved.cmd,
        args: resolved.args,
        cwd,
        err: String(err),
      });
      throw err;
    }
  }

  async openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
    agentCommand: string[];
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
  }): Promise<{ handle: ProcessHandle; created: boolean; initPending: boolean }> {
    if (!opts.agentCommand.length) throw new Error("agent_command is empty");
    const workspaceHostPath = this.resolveWorkspaceHostPath({
      instanceName: opts.instanceName,
      runId: opts.runId,
      mounts: opts.mounts,
    });
    await mkdir(workspaceHostPath, { recursive: true });

    const inst = this.instances.get(opts.instanceName);
    if (inst?.agentProc && inst.agentHandle) {
      this.opts.log("host_process reuse agent", { instanceName: opts.instanceName });
      return { handle: inst.agentHandle, created: false, initPending: false };
    }

    const [cmd, ...args] = opts.agentCommand;
    const env = { ...process.env, ...this.opts.config.env };

    const useCmdShim = needsCmdShimOnWindows(cmd);
    const resolved = useCmdShim
      ? buildCmdShimSpawn(opts.agentCommand, workspaceHostPath, env)
      : {
          cmd,
          args,
          spawnOpts: {
            cwd: workspaceHostPath,
            env,
            stdio: PIPE_STDIO,
            windowsHide: true,
          },
        };

    this.opts.log("host_process start agent", {
      instanceName: opts.instanceName,
      cmd: resolved.cmd,
      args: resolved.args,
      cwd: workspaceHostPath,
      shim: useCmdShim ? "cmd.exe" : null,
      rawCmd: cmd,
    });

    const proc = spawn(resolved.cmd, resolved.args, resolved.spawnOpts) as ChildProcessWithoutNullStreams;
    const handle = processHandleFromChildProcess(proc);

    const createdAt = inst?.createdAt ?? new Date().toISOString();
    const record: HostInstance = inst ?? {
      instanceName: opts.instanceName,
      runId: opts.runId?.trim() || null,
      workspaceHostPath,
      createdAt,
      agentProc: null,
      agentHandle: null,
    };
    record.workspaceHostPath = workspaceHostPath;
    record.agentProc = proc;
    record.agentHandle = handle;
    record.createdAt = createdAt;
    this.instances.set(opts.instanceName, record);

    handle.onExit?.(() => {
      const latest = this.instances.get(opts.instanceName);
      if (!latest) return;
      if (latest.agentProc === proc) {
        latest.agentProc = null;
        latest.agentHandle = null;
      }
    });

    return { handle, created: true, initPending: false };
  }
}
