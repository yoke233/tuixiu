import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type {
  ProcessHandle,
  RunProcessOpts,
  SandboxProvider,
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

export class ContainerSandbox implements SandboxProvider {
  constructor(
    private readonly opts: { log: Logger; config: ContainerSandboxConfig },
  ) {}

  async runProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    const cfg = this.opts.config;
    const runtime = cfg.runtime?.trim() ? cfg.runtime.trim() : "docker";
    if (!cfg.image.trim()) throw new Error("Container 配置缺失：sandbox.image");
    if (!opts.command.length) throw new Error("command 为空");

    const workingDir = cfg.workingDir?.trim()
      ? cfg.workingDir.trim()
      : "/workspace";

    const envForProc = { ...cfg.env, ...opts.env };
    const volumes: ContainerVolume[] = [
      { hostPath: opts.cwd, guestPath: "/workspace", readOnly: false },
      ...(cfg.volumes ?? []),
    ];

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
