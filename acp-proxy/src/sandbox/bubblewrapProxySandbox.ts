import { spawn, type ChildProcessWithoutNullStreams, type StdioOptions } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";

import type { LoadedProxyConfig } from "../config.js";
import type { ProxySandbox } from "./ProxySandbox.js";
import {
  readNativeRegistry,
  removeNativeRegistryEntry,
  upsertNativeRegistryEntry,
} from "./nativeRegistry.js";
import type {
  EnsureInstanceRunningOpts,
  ListInstancesOpts,
  ProcessHandle,
  SandboxInstanceInfo,
} from "./types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type BubblewrapSandboxCfg = LoadedProxyConfig["sandbox"] & { provider: "bwrap" };

type BubblewrapInstance = {
  instanceName: string;
  runId: string | null;
  workspaceHostPath: string;
  mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
  createdAt: string;
  agentProc: ChildProcessWithoutNullStreams | null;
  agentHandle: ProcessHandle | null;
};

const WORKSPACE_GUEST_ROOT = "/workspace";
const PIPE_STDIO = ["pipe", "pipe", "pipe"] as StdioOptions;

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

function normalizeAbsoluteGuestMountPath(guestPath: string): string {
  const raw = guestPath.trim();
  if (!raw) throw new Error("guestPath is empty");
  if (!raw.startsWith("/")) throw new Error("guestPath must be absolute");
  if (raw.split("/").some((seg) => seg === "..")) throw new Error("guestPath must not include '..'");
  const normalized = path.posix.normalize(raw);
  if (!normalized.startsWith("/")) throw new Error("guestPath must be absolute");
  return normalized;
}

function normalizeAbsolutePosixPath(p: string): string {
  const raw = p.trim();
  if (!raw) throw new Error("path is empty");
  if (!raw.startsWith("/")) throw new Error("path must be absolute");
  if (raw.split("/").some((seg) => seg === "..")) throw new Error("path must not include '..'");
  const normalized = path.posix.normalize(raw);
  if (!normalized.startsWith("/")) throw new Error("path must be absolute");
  return normalized;
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildBwrapArgs(opts: {
  workspaceHostPath: string;
  mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
  cwdInGuest: string;
  command: string[];
  userView?: { username: string; uid: number; gid: number; homeGuestPath: string; passwdHostPath: string; groupHostPath: string };
}): string[] {
  const cwdInGuest = normalizeGuestPath(opts.cwdInGuest);
  const mounts = Array.isArray(opts.mounts) ? opts.mounts : [];

  const bwrapArgs: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--share-net",

    ...(opts.userView
      ? [
          "--unshare-user",
          "--uid",
          String(opts.userView.uid),
          "--gid",
          String(opts.userView.gid),
          "--setenv",
          "HOME",
          opts.userView.homeGuestPath,
          "--setenv",
          "USER",
          opts.userView.username,
          "--setenv",
          "LOGNAME",
          opts.userView.username,
        ]
      : []),

    // 基于宿主机 root，但只读（后续再把 workspace/volumes 以 RW bind 方式覆盖进来）
    "--ro-bind",
    "/",
    "/",

    // 重新挂载基础伪文件系统（覆盖掉 ro-bind 的 /proc,/dev）
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",

    ...(opts.userView
      ? [
          "--ro-bind",
          opts.userView.passwdHostPath,
          "/etc/passwd",
          "--ro-bind",
          opts.userView.groupHostPath,
          "/etc/group",
        ]
      : []),

    "--dir",
    WORKSPACE_GUEST_ROOT,

    // workspace bind 必须是 RW（不然无法写入 run workspace）
    "--bind",
    opts.workspaceHostPath,
    WORKSPACE_GUEST_ROOT,
  ];

  for (const m of mounts) {
    if (!m || typeof m !== "object") continue;
    const hostPathRaw = typeof m.hostPath === "string" ? m.hostPath.trim() : "";
    const guestPathRaw = typeof m.guestPath === "string" ? m.guestPath.trim() : "";
    if (!hostPathRaw || !guestPathRaw) continue;

    const hostPath = path.isAbsolute(hostPathRaw) ? hostPathRaw : path.resolve(process.cwd(), hostPathRaw);
    const guestPath = normalizeAbsoluteGuestMountPath(guestPathRaw);

    if (guestPath === WORKSPACE_GUEST_ROOT) continue;

    const parent = path.posix.dirname(guestPath);
    if (parent && parent !== "/") {
      bwrapArgs.push("--dir", parent);
    }

    if (m.readOnly) {
      bwrapArgs.push("--ro-bind", hostPath, guestPath);
    } else {
      bwrapArgs.push("--bind", hostPath, guestPath);
    }
  }

  bwrapArgs.push("--chdir", cwdInGuest, "--", ...(opts.command as [string, ...string[]]));
  return bwrapArgs;
}

export class BubblewrapProxySandbox implements ProxySandbox {
  readonly provider = "bwrap" as const;
  readonly runtime = null;
  readonly agentMode = "exec" as const;

  private readonly instances = new Map<string, BubblewrapInstance>();

  constructor(private readonly opts: { config: BubblewrapSandboxCfg; log: Logger }) {
    this.opts.log("bubblewrap proxy sandbox init", {
      workspaceHostRoot: opts.config.workspaceHostRoot,
      bwrap: "bwrap",
    });
  }

  private resolveBwrapBin(): string {
    return "bwrap";
  }

  private resolveWorkspaceHostRoot(): string {
    const rootRaw = this.opts.config.workspaceHostRoot?.trim() ?? "";
    if (!rootRaw) throw new Error("sandbox.workspaceHostRoot missing");
    const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
    return path.resolve(root);
  }

  private resolveRegistryPath(): string {
    const root = this.resolveWorkspaceHostRoot();
    return path.join(root, ".acp-proxy", "registry.json");
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
      if (opts.mounts) existing.mounts = opts.mounts;
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
      mounts: opts.mounts,
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

    const known = new Set<string>();
    const out: SandboxInstanceInfo[] = [];

    for (const inst of instances) {
      known.add(inst.instanceName);
      out.push({
        instanceName: inst.instanceName,
        status: "running",
        createdAt: inst.createdAt,
      });
    }

    const registryPath = this.resolveRegistryPath();
    const registry = await readNativeRegistry(registryPath).catch(() => []);
    for (const entry of registry) {
      if (known.has(entry.instanceName)) continue;
      if (prefix && !entry.instanceName.startsWith(prefix)) continue;
      known.add(entry.instanceName);
      out.push({
        instanceName: entry.instanceName,
        status: isPidAlive(entry.pid) ? "running" : "missing",
        createdAt: entry.startedAt,
      });
    }

    return out;
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
    const registryPath = this.resolveRegistryPath();
    const registryEntry = await readNativeRegistry(registryPath)
      .then((rows) => rows.find((r) => r.instanceName === instanceName) ?? null)
      .catch(() => null);

    await this.stopInstance(instanceName);

    if (registryEntry?.pid) {
      try {
        process.kill(registryEntry.pid);
      } catch {
        // ignore
      }
    }

    this.instances.delete(instanceName);
    await removeNativeRegistryEntry(registryPath, instanceName).catch(() => {});
  }

  async removeImage(_image: string): Promise<void> {
    throw new Error(`bubblewrap does not support remove_image (${_image})`);
  }

  async execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle> {
    if (process.platform !== "linux") {
      throw new Error("bubblewrap sandbox 仅支持 Linux");
    }
    if (!opts.command.length) throw new Error("command is empty");

    const inst = this.instances.get(opts.instanceName);
    if (!inst) throw new Error("instance missing");

    const env = { ...process.env, ...this.opts.config.env, ...opts.env };

    const userView = await this.prepareUserView({
      workspaceHostPath: inst.workspaceHostPath,
      env: opts.env,
    });

    const args = buildBwrapArgs({
      workspaceHostPath: inst.workspaceHostPath,
      mounts: [...(inst.mounts ?? []), ...(this.opts.config.volumes ?? [])],
      cwdInGuest: opts.cwdInGuest,
      command: opts.command,
      ...(userView ? { userView } : {}),
    });

    this.opts.log("bubblewrap execProcess", {
      instanceName: opts.instanceName,
      cmd: this.resolveBwrapBin(),
      args,
      hostCwd: inst.workspaceHostPath,
    });

    const proc = spawn(this.resolveBwrapBin(), args, {
      cwd: inst.workspaceHostPath,
      env,
      stdio: PIPE_STDIO,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    return processHandleFromChildProcess(proc);
  }

  async openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    mounts?: { hostPath: string; guestPath: string; readOnly?: boolean }[];
    agentCommand: string[];
    init?: { script?: string; timeout_seconds?: number; env?: Record<string, string> };
  }): Promise<{ handle: ProcessHandle; created: boolean; initPending: boolean }> {
    if (process.platform !== "linux") {
      throw new Error("bubblewrap sandbox 仅支持 Linux");
    }
    if (!opts.agentCommand.length) throw new Error("agent_command is empty");

    const workspaceHostPath = this.resolveWorkspaceHostPath({
      instanceName: opts.instanceName,
      runId: opts.runId,
      mounts: opts.mounts,
    });
    await mkdir(workspaceHostPath, { recursive: true });

    const inst = this.instances.get(opts.instanceName);
    if (inst?.agentProc && inst.agentHandle) {
      this.opts.log("bubblewrap reuse agent", { instanceName: opts.instanceName });
      return { handle: inst.agentHandle, created: false, initPending: false };
    }

    const env = { ...process.env, ...this.opts.config.env };
    const initEnv =
      opts.init?.env && typeof opts.init.env === "object" && !Array.isArray(opts.init.env)
        ? { ...(opts.init.env as Record<string, string>) }
        : null;
    if (initEnv) Object.assign(env, initEnv);

    const userView = await this.prepareUserView({
      workspaceHostPath,
      env: initEnv ?? undefined,
    });

    const args = buildBwrapArgs({
      workspaceHostPath,
      mounts: [...(opts.mounts ?? []), ...(this.opts.config.volumes ?? [])],
      cwdInGuest: opts.workspaceGuestPath,
      command: opts.agentCommand,
      ...(userView ? { userView } : {}),
    });

    this.opts.log("bubblewrap start agent", {
      instanceName: opts.instanceName,
      cmd: this.resolveBwrapBin(),
      args,
      hostCwd: workspaceHostPath,
    });

    const proc = spawn(this.resolveBwrapBin(), args, {
      cwd: workspaceHostPath,
      env,
      stdio: PIPE_STDIO,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const handle = processHandleFromChildProcess(proc);

    const createdAt = inst?.createdAt ?? new Date().toISOString();
    const record: BubblewrapInstance = inst ?? {
      instanceName: opts.instanceName,
      runId: opts.runId?.trim() || null,
      workspaceHostPath,
      mounts: opts.mounts,
      createdAt,
      agentProc: null,
      agentHandle: null,
    };
    record.workspaceHostPath = workspaceHostPath;
    record.mounts = opts.mounts;
    record.agentProc = proc;
    record.agentHandle = handle;
    record.createdAt = createdAt;
    this.instances.set(opts.instanceName, record);

    if (proc.pid) {
      await upsertNativeRegistryEntry(this.resolveRegistryPath(), {
        instanceName: opts.instanceName,
        pid: proc.pid,
        workspaceHostPath,
        startedAt: createdAt,
      }).catch((err) => {
        this.opts.log("bubblewrap registry write failed", { instanceName: opts.instanceName, err: String(err) });
      });
    }

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

  private async prepareUserView(opts: {
    workspaceHostPath: string;
    env?: Record<string, string>;
  }): Promise<
    | {
        username: string;
        uid: number;
        gid: number;
        homeGuestPath: string;
        passwdHostPath: string;
        groupHostPath: string;
      }
    | null
  > {
    const env = opts.env ?? {};
    const usernameRaw = String(env.TUIXIU_BWRAP_USERNAME ?? env.USER ?? env.LOGNAME ?? "agent").trim();
    const username = usernameRaw || "agent";

    const uidRaw = Number(env.TUIXIU_BWRAP_UID ?? "1000");
    const gidRaw = Number(env.TUIXIU_BWRAP_GID ?? env.TUIXIU_BWRAP_UID ?? "1000");
    const uid = Number.isFinite(uidRaw) ? Math.max(0, Math.floor(uidRaw)) : 1000;
    const gid = Number.isFinite(gidRaw) ? Math.max(0, Math.floor(gidRaw)) : uid;

    const homeRaw = String(env.TUIXIU_BWRAP_HOME_PATH ?? env.USER_HOME ?? env.HOME ?? "/home/agent").trim();
    const homeGuestPath = normalizeAbsolutePosixPath(homeRaw);

    const etcDir = path.join(opts.workspaceHostPath, ".tuixiu", "bwrap", "etc");
    await mkdir(etcDir, { recursive: true });
    const passwdHostPath = path.join(etcDir, "passwd");
    const groupHostPath = path.join(etcDir, "group");

    const passwd = [
      `root:x:0:0:root:/root:/bin/sh`,
      `${username}:x:${uid}:${gid}:ACP User:${homeGuestPath}:/bin/sh`,
      "",
    ].join("\n");
    const group = [`root:x:0:`, `${username}:x:${gid}:`, ""].join("\n");

    await mkdir(path.dirname(passwdHostPath), { recursive: true });
    await mkdir(path.dirname(groupHostPath), { recursive: true });
    await writeFile(passwdHostPath, passwd, "utf8");
    await writeFile(groupHostPath, group, "utf8");

    return { username, uid, gid, homeGuestPath, passwdHostPath, groupHostPath };
  }
}
