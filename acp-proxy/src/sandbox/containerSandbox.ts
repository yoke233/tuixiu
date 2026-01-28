import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import type {
  EnsureInstanceRunningOpts,
  ExecProcessInInstanceOpts,
  ListInstancesOpts,
  ProcessHandle,
  RunProcessOpts,
  SandboxProvider,
  SandboxInstanceInfo,
  SandboxInstanceProvider,
} from "./types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type ContainerVolume = {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
};

export type ContainerSandboxConfig = {
  runtime: string;
  image: string;
  workingDir?: string;
  volumes?: ContainerVolume[];
  env?: Record<string, string>;
  cpus?: number;
  memoryMib?: number;
  extraRunArgs?: string[];
};

function toEnvArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.trim()) continue;
    args.push("-e", `${key}=${value}`);
  }
  return args;
}

function toVolumeArgs(volumes: ContainerVolume[] | undefined): string[] {
  if (!volumes?.length) return [];
  const args: string[] = [];
  for (const v of volumes) {
    const hostPath = v.hostPath.trim();
    const guestPath = v.guestPath.trim();
    if (!hostPath || !guestPath) continue;
    const suffix = v.readOnly ? ":ro" : "";
    args.push("-v", `${hostPath}:${guestPath}${suffix}`);
  }
  return args;
}

function randomName(prefix: string): string {
  const r = Math.random().toString(16).slice(2);
  return `${prefix}-${Date.now()}-${r}`;
}

function isNoSuchContainer(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("no such container") ||
    t.includes("no such object") ||
    t.includes("does not exist") ||
    t.includes("not found")
  );
}

async function spawnCapture(
  runtime: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = spawn(runtime, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (d) => (stdout += String(d ?? "")));
  proc.stderr?.on("data", (d) => (stderr += String(d ?? "")));

  const spawned = await new Promise<boolean>((resolve) => {
    proc.once("spawn", () => resolve(true));
    proc.once("error", () => resolve(false));
  });

  if (!spawned) {
    proc.kill();
    throw new Error(`未找到容器运行时命令：${runtime}`);
  }

  const code = await new Promise<number | null>((resolve) => {
    proc.once("exit", (c) => resolve(c ?? null));
    proc.once("error", () => resolve(1));
  });

  return { code, stdout, stderr };
}

export class ContainerSandbox implements SandboxProvider, SandboxInstanceProvider {
  readonly provider = "container_oci" as const;
  get runtime(): string {
    const raw = this.opts.config.runtime?.trim();
    return raw ? raw : "docker";
  }

  constructor(
    private readonly opts: { log: Logger; config: ContainerSandboxConfig },
  ) {}

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    const name = instanceName.trim();
    if (!name) throw new Error("instanceName 为空");

    const runtime = this.runtime;
    const res = await spawnCapture(runtime, ["inspect", name]);
    if (res.code !== 0) {
      const text = `${res.stdout}\n${res.stderr}`;
      if (isNoSuchContainer(text)) {
        return { instanceName: name, status: "missing", createdAt: null };
      }
      throw new Error(`container inspect 失败：${text.trim()}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`container inspect 输出无法解析为 JSON：${String(err)}`);
    }

    const info = Array.isArray(parsed) ? parsed[0] : parsed;
    const state = String(info?.State?.Status ?? "").toLowerCase();
    const status = state === "running" ? "running" : "stopped";
    const createdAt = typeof info?.Created === "string" ? info.Created : null;

    return { instanceName: name, status, createdAt };
  }

  async ensureInstanceRunning(
    opts: EnsureInstanceRunningOpts,
  ): Promise<SandboxInstanceInfo> {
    const cfg = this.opts.config;
    const runtime = this.runtime;

    const instanceName = opts.instanceName.trim();
    if (!instanceName) throw new Error("instanceName 为空");
    if (!cfg.image.trim()) throw new Error("Container 配置缺失：sandbox.image");

    const existing = await this.inspectInstance(instanceName);
    if (existing.status === "running") return existing;

    if (existing.status === "stopped") {
      this.opts.log("container start", { runtime, name: instanceName });
      const started = await spawnCapture(runtime, ["start", instanceName]);
      if (started.code !== 0) {
        throw new Error(
          `container start 失败：${`${started.stdout}\n${started.stderr}`.trim()}`,
        );
      }
      return await this.inspectInstance(instanceName);
    }

    const workingDir = cfg.workingDir?.trim()
      ? cfg.workingDir.trim()
      : opts.workspaceGuestPath.trim()
        ? opts.workspaceGuestPath.trim()
        : "/workspace";

    const envForContainer = { ...cfg.env, ...opts.env };
    const volumes: ContainerVolume[] = [...(cfg.volumes ?? [])];

    const args: string[] = ["run", "-d", "--name", instanceName, "-w", workingDir];
    args.push("--label", "acp-proxy.managed=1");
    if (opts.runId.trim()) args.push("--label", `acp-proxy.run_id=${opts.runId.trim()}`);

    args.push(...(cfg.extraRunArgs ?? []));
    if (typeof cfg.cpus === "number") args.push("--cpus", String(cfg.cpus));
    if (typeof cfg.memoryMib === "number")
      args.push("--memory", `${cfg.memoryMib}m`);

    args.push(...toEnvArgs(envForContainer));
    args.push(...toVolumeArgs(volumes));

    const guestWorkspace = opts.workspaceGuestPath.trim()
      ? opts.workspaceGuestPath.trim()
      : "/workspace";
    args.push(
      cfg.image,
      "sh",
      "-c",
      `mkdir -p '${guestWorkspace.replace(/'/g, "'\\''")}'\nwhile true; do sleep 3600; done`,
    );

    this.opts.log("container ensure running (create)", {
      runtime,
      image: cfg.image,
      name: instanceName,
      workingDir,
    });

    const created = await spawnCapture(runtime, args);
    if (created.code !== 0) {
      throw new Error(
        `container run 失败：${`${created.stdout}\n${created.stderr}`.trim()}`,
      );
    }

    return await this.inspectInstance(instanceName);
  }

  async stopInstance(instanceName: string): Promise<void> {
    const name = instanceName.trim();
    if (!name) return;
    const runtime = this.runtime;
    this.opts.log("container stop", { runtime, name });
    const res = await spawnCapture(runtime, ["stop", name]);
    if (res.code === 0) return;
    const text = `${res.stdout}\n${res.stderr}`;
    if (isNoSuchContainer(text)) return;
    throw new Error(`container stop 失败：${text.trim()}`);
  }

  async removeInstance(instanceName: string): Promise<void> {
    const name = instanceName.trim();
    if (!name) return;
    const runtime = this.runtime;
    this.opts.log("container remove", { runtime, name });
    const res = await spawnCapture(runtime, ["rm", "-f", name]);
    if (res.code === 0) return;
    const text = `${res.stdout}\n${res.stderr}`;
    if (isNoSuchContainer(text)) return;
    throw new Error(`container remove 失败：${text.trim()}`);
  }

  async execProcess(opts: ExecProcessInInstanceOpts): Promise<ProcessHandle> {
    const cfg = this.opts.config;
    const runtime = this.runtime;
    if (!cfg.image.trim()) throw new Error("Container 配置缺失：sandbox.image");
    if (!opts.command.length) throw new Error("command 为空");
    if (!opts.instanceName.trim()) throw new Error("instanceName 为空");

    const cwdInGuest = opts.cwdInGuest?.trim() ? opts.cwdInGuest.trim() : "/workspace";
    const envForProc = { ...cfg.env, ...opts.env };

    const pidFile = `/tmp/acp-proxy/pids/${randomUUID()}.pid`;
    const wrappedCommand: string[] = [
      "sh",
      "-c",
      [
        "set -e",
        'pid_file="$1"',
        "shift",
        'mkdir -p "${pid_file%/*}"',
        'cleanup() { rm -f "$pid_file"; }',
        "trap cleanup EXIT INT TERM HUP",
        '"$@" &',
        "pid=$!",
        'echo "$pid" > "$pid_file"',
        'wait "$pid"',
      ].join("\n"),
      "sh",
      pidFile,
      ...opts.command,
    ];

    const args: string[] = [
      "exec",
      "-i",
      "-w",
      cwdInGuest,
      ...toEnvArgs(envForProc),
      opts.instanceName,
      ...wrappedCommand,
    ];

    this.opts.log("container exec", {
      runtime,
      name: opts.instanceName,
      cwd: cwdInGuest,
      cmd: opts.command[0],
    });

    const proc = spawn(runtime, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => {
        const msg =
          (err as any)?.code === "ENOENT"
            ? `未找到容器运行时命令：${runtime}`
            : `${runtime} 启动失败：${String(err)}`;
        reject(new Error(msg));
      });
    });

    const exitListeners = new Set<
      (info: { code: number | null; signal: string | null }) => void
    >();
    const notifyExit = (info: {
      code: number | null;
      signal: string | null;
    }) => {
      for (const cb of exitListeners) cb(info);
    };

    proc.on("exit", (code, signal) => {
      notifyExit({ code: code ?? null, signal: signal ?? null });
    });

    if (!proc.stdin || !proc.stdout) {
      proc.kill();
      throw new Error("container stdio 不可用");
    }

    const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const stdout = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stderr = proc.stderr
      ? (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>)
      : undefined;

    return {
      stdin,
      stdout,
      stderr,
      close: async () => {
        try {
          const killScript = [
            "set -e",
            'pid_file="$1"',
            "for _i in 1 2 3 4 5 6 7 8 9 10; do",
            "  [ -f \"$pid_file\" ] && break",
            "  sleep 0.05",
            "done",
            "if [ -f \"$pid_file\" ]; then",
            '  pid="$(cat \"$pid_file\" 2>/dev/null | tr -cd \"0-9\")"',
            "  if [ -n \"$pid\" ]; then",
            '    kill -TERM \"$pid\" 2>/dev/null || true',
            "    sleep 0.2",
            '    kill -KILL \"$pid\" 2>/dev/null || true',
            "  fi",
            "fi",
          ].join("\n");
          await spawnCapture(runtime, [
            "exec",
            opts.instanceName,
            "sh",
            "-c",
            killScript,
            "sh",
            pidFile,
          ]).catch(() => {});

          proc.kill();
        } catch {}
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };
  }

  async listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]> {
    const runtime = this.runtime;
    const managedOnly = opts?.managedOnly ?? true;
    const namePrefix = opts?.namePrefix?.trim() ? opts.namePrefix.trim() : null;

    const args: string[] = ["ps", "-a"];
    if (managedOnly) args.push("--filter", "label=acp-proxy.managed=1");
    if (namePrefix) args.push("--filter", `name=${namePrefix}`);
    args.push("--format", "{{.Names}}");

    const res = await spawnCapture(runtime, args);
    if (res.code !== 0) {
      throw new Error(
        `container ps 失败：${`${res.stdout}\n${res.stderr}`.trim()}`,
      );
    }

    const names = res.stdout
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);

    const out: SandboxInstanceInfo[] = [];
    for (const name of names) {
      try {
        const info = await this.inspectInstance(name);
        if (info.status === "missing") continue;
        out.push(info);
      } catch (err) {
        this.opts.log("container inspect failed during inventory", {
          name,
          err: String(err),
        });
      }
    }
    return out;
  }

  async runProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    const cfg = this.opts.config;
    const runtime = this.runtime;
    if (!cfg.image.trim()) throw new Error("Container 配置缺失：sandbox.image");
    if (!opts.command.length) throw new Error("command 为空");

    const workingDir = cfg.workingDir?.trim()
      ? cfg.workingDir.trim()
      : "/workspace";

    const envForProc = { ...cfg.env, ...opts.env };
    const volumes: ContainerVolume[] = [...(cfg.volumes ?? [])];

    const name = randomName("acp-proxy");
    const args: string[] = [
      "run",
      "--rm",
      "-i",
      "--name",
      name,
      "-w",
      workingDir,
      ...(cfg.extraRunArgs ?? []),
    ];
    if (typeof cfg.cpus === "number") args.push("--cpus", String(cfg.cpus));
    if (typeof cfg.memoryMib === "number")
      args.push("--memory", `${cfg.memoryMib}m`);
    args.push(...toEnvArgs(envForProc));
    args.push(...toVolumeArgs(volumes));
    args.push(cfg.image, ...opts.command);

    this.opts.log("container run", {
      runtime,
      image: cfg.image,
      name,
      workingDir,
    });

    const proc = spawn(runtime, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err) => {
        const msg =
          (err as any)?.code === "ENOENT"
            ? `未找到容器运行时命令：${runtime}`
            : `${runtime} 启动失败：${String(err)}`;
        reject(new Error(msg));
      });
    });

    const exitListeners = new Set<
      (info: { code: number | null; signal: string | null }) => void
    >();
    const notifyExit = (info: {
      code: number | null;
      signal: string | null;
    }) => {
      for (const cb of exitListeners) cb(info);
    };

    proc.on("exit", (code, signal) => {
      notifyExit({ code: code ?? null, signal: signal ?? null });
    });

    if (!proc.stdin || !proc.stdout) {
      proc.kill();
      throw new Error("container stdio 不可用");
    }

    const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const stdout = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stderr = proc.stderr
      ? (Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>)
      : undefined;

    return {
      stdin,
      stdout,
      stderr,
      close: async () => {
        try {
          if (proc.exitCode === null) {
            try {
              spawn(runtime, ["kill", name], {
                stdio: "ignore",
                windowsHide: true,
              });
            } catch {}
          }
          proc.kill();
        } catch {}
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };
  }
}
