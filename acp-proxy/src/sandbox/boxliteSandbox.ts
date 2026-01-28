import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

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

type BoxliteVolume = {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
};

export type BoxliteSandboxConfig = {
  image: string;
  workingDir?: string;
  volumes?: BoxliteVolume[];
  env?: Record<string, string>;
  cpus?: number;
  memoryMib?: number;
};

async function assertBoxliteSupportedPlatform(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error(
      "BoxLite Node SDK 不支持 Windows 原生运行（无 win32 架构产物）。请在 WSL2/Linux 或 macOS(Apple Silicon) 上运行 acp-proxy，再由 BoxLite 启动 ACP",
    );
  }

  if (process.platform === "darwin") {
    if (process.arch !== "arm64") {
      throw new Error(
        "BoxLite 仅支持 macOS Apple Silicon(arm64)。Intel Mac 请使用 sandbox.provider=host_process 或在 Linux/WSL2 上运行",
      );
    }
    return;
  }

  if (process.platform === "linux") {
    try {
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      throw new Error(
        "BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm",
      );
    }
    return;
  }

  throw new Error(`BoxLite 暂不支持当前平台: ${process.platform}`);
}

async function importBoxliteModule(): Promise<any> {
  try {
    return await import("@boxlite-ai/boxlite");
  } catch (errA) {
    try {
      const legacyPkgName: string = "boxlite";
      return await import(legacyPkgName);
    } catch (errB) {
      throw new Error(
        "未安装 BoxLite Node SDK。请先运行 pnpm install（或 pnpm -C acp-proxy install）；如仍缺失可手动安装：pnpm -C acp-proxy add @boxlite-ai/boxlite（或 pnpm -C acp-proxy add boxlite）",
      );
    }
  }
}

async function importSimpleBoxClass(): Promise<any> {
  const mod = await importBoxliteModule();
  const SimpleBox = mod.SimpleBox ?? mod.default?.SimpleBox ?? null;
  if (!SimpleBox) {
    throw new Error("BoxLite SDK API 不匹配：未找到 SimpleBox 导出");
  }
  return SimpleBox;
}

function toEnvArray(
  env: Record<string, string> | undefined,
): Array<[string, string]> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).filter(([k]) => k.trim());
  if (!entries.length) return undefined;
  return entries;
}

async function ensureNativeBox(boxLike: any): Promise<any> {
  if (boxLike && typeof boxLike._ensureBox === "function") {
    return await boxLike._ensureBox();
  }
  return boxLike;
}

export class BoxliteSandbox implements SandboxProvider, SandboxInstanceProvider {
  readonly provider = "boxlite_oci" as const;
  readonly runtime: string | undefined = undefined;

  private box: any | null = null;
  private boxMeta: { image: string; workingDir: string; instanceName: string } | null = null;

  constructor(
    private readonly opts: { log: Logger; config: BoxliteSandboxConfig },
  ) {}

  private async ensureBox(opts: {
    instanceName: string;
    envForProc: Record<string, string>;
  }): Promise<any> {
    await assertBoxliteSupportedPlatform();

    const cfg = this.opts.config;
    if (!cfg.image.trim())
      throw new Error("BoxLite 配置缺失：sandbox.boxlite.image");

    const SimpleBox = await importSimpleBoxClass();

    const envForProc = opts.envForProc;

    const workingDir = cfg.workingDir?.trim()
      ? cfg.workingDir.trim()
      : "/workspace";
    if (workingDir !== "/workspace" && !workingDir.startsWith("/workspace/")) {
      throw new Error("sandbox.boxlite.workingDir 必须位于 /workspace 下");
    }

    const boxOpts = {
      image: cfg.image,
      cpus: cfg.cpus,
      memoryMib: cfg.memoryMib,
      autoRemove: true,
      workingDir,
      env: envForProc,
      volumes: cfg.volumes ?? [],
    };

    this.opts.log("boxlite create", {
      image: cfg.image,
      workingDir: boxOpts.workingDir,
    });
    if (this.box) {
      try {
        await this.box.stop();
      } catch (err) {
        this.opts.log("boxlite stop previous box failed", { err: String(err) });
      } finally {
        this.box = null;
      }
    }

    const box = new SimpleBox(boxOpts);
    this.box = box;
    this.boxMeta = { image: cfg.image, workingDir, instanceName: opts.instanceName };
    return box;
  }

  async inspectInstance(instanceName: string): Promise<SandboxInstanceInfo> {
    const name = instanceName.trim();
    if (!name) throw new Error("instanceName 为空");
    if (!this.box || !this.boxMeta || this.boxMeta.instanceName !== name) {
      return { instanceName: name, status: "missing", createdAt: null };
    }
    return { instanceName: name, status: "running", createdAt: null };
  }

  async ensureInstanceRunning(
    opts: EnsureInstanceRunningOpts,
  ): Promise<SandboxInstanceInfo> {
    const instanceName = opts.instanceName.trim();
    if (!instanceName) throw new Error("instanceName 为空");

    const cfg = this.opts.config;
    const envForProc = { ...cfg.env, ...opts.env };
    await this.ensureBox({
      instanceName,
      envForProc,
    });

    return { instanceName, status: "running", createdAt: null };
  }

  async stopInstance(instanceName: string): Promise<void> {
    const name = instanceName.trim();
    if (!name) return;
    if (!this.boxMeta || this.boxMeta.instanceName !== name) return;
    await this.stopBox();
  }

  async removeInstance(instanceName: string): Promise<void> {
    await this.stopInstance(instanceName);
  }

  async listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]> {
    const info = this.boxMeta
      ? await this.inspectInstance(this.boxMeta.instanceName)
      : null;
    if (!info || info.status === "missing") return [];

    const prefix = opts?.namePrefix?.trim() ? opts.namePrefix.trim() : null;
    if (prefix && !info.instanceName.startsWith(prefix)) return [];
    return [info];
  }

  async runProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    const cfg = this.opts.config;
    const envForProc = { ...cfg.env, ...opts.env };
    const instanceName = `acp-proxy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const box = await this.ensureBox({ instanceName, envForProc });

    if (!opts.command.length) throw new Error("agent_command 为空");
    const [cmd, ...args] = opts.command;

    this.opts.log("boxlite exec acp agent", {
      cmd,
      args,
      cwd: this.boxMeta?.workingDir ?? "/workspace",
    });

    const nativeBox = await ensureNativeBox(box);
    const exec = await nativeBox.exec(cmd, args, toEnvArray(envForProc), false);

    const stdinHandle = await exec.stdin();
    const stdoutHandle = await exec.stdout();
    const stderrHandle = await exec.stderr().catch(() => null);

    const exitListeners = new Set<
      (info: { code: number | null; signal: string | null }) => void
    >();
    const notifyExit = (info: {
      code: number | null;
      signal: string | null;
    }) => {
      for (const cb of exitListeners) cb(info);
    };

    void exec
      .wait()
      .then((res: { exitCode: number }) => {
        notifyExit({ code: res.exitCode, signal: null });
      })
      .catch((err: unknown) => {
        this.opts.log("boxlite execution wait failed", { err: String(err) });
        notifyExit({ code: null, signal: null });
      });

    const encoder = new TextEncoder();
    const toReadable = (next: () => Promise<string | null>) =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const line = await next();
          if (line === null) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(line));
        },
      });

    const handle: ProcessHandle = {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await stdinHandle.write(Buffer.from(chunk));
        },
      }),
      stdout: toReadable(() => stdoutHandle.next()),
      stderr: stderrHandle ? toReadable(() => stderrHandle.next()) : undefined,
      close: async () => {
        try {
          await box.stop();
        } catch (err) {
          this.opts.log("boxlite stop failed", { err: String(err) });
        } finally {
          if (this.box === box) this.box = null;
          if (this.box === null) this.boxMeta = null;
        }
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };

    return handle;
  }

  async execProcess(opts: RunProcessOpts | ExecProcessInInstanceOpts): Promise<ProcessHandle> {
    await assertBoxliteSupportedPlatform();

    const box = this.box;
    if (!box) throw new Error("BoxLite box 尚未创建，无法 exec。请先启动 ACP agent");

    const cfg = this.opts.config;
    const envForProc = { ...cfg.env, ...(opts as any).env };

    const cwdInGuest =
      "cwdInGuest" in opts && typeof opts.cwdInGuest === "string" && opts.cwdInGuest.trim()
        ? opts.cwdInGuest.trim()
        : cfg.workingDir?.trim()
          ? cfg.workingDir.trim()
          : "/workspace";
    if (cwdInGuest !== "/workspace" && !cwdInGuest.startsWith("/workspace/")) {
      throw new Error("boxlite exec cwd 必须位于 /workspace 下");
    }

    if ("instanceName" in opts) {
      const expected = this.boxMeta?.instanceName ?? null;
      if (expected && expected !== opts.instanceName) {
        throw new Error("BoxLite 当前 box 不属于该 instanceName，无法 exec");
      }
    }

    const command = opts.command;
    if (!command.length) throw new Error("command 为空");

    const pidFile = `/tmp/acp-proxy/pids/${randomUUID()}.pid`;
    const wrappedCommand: string[] = [
      "sh",
      "-c",
      [
        "set -e",
        'cwd="$1"',
        'pid_file="$2"',
        "shift 2",
        'mkdir -p "${pid_file%/*}"',
        'cleanup() { rm -f "$pid_file"; }',
        "trap cleanup EXIT INT TERM HUP",
        'cd "$cwd"',
        '"$@" &',
        "pid=$!",
        'echo "$pid" > "$pid_file"',
        'wait "$pid"',
      ].join("\n"),
      "sh",
      cwdInGuest,
      pidFile,
      ...command,
    ];

    const [cmd, ...args] = wrappedCommand;

    this.opts.log("boxlite exec", { cmd: command[0], args: command.slice(1), cwd: cwdInGuest });

    const nativeBox = await ensureNativeBox(box);
    const exec = await nativeBox.exec(cmd, args, toEnvArray(envForProc), false);

    const stdinHandle = await exec.stdin();
    const stdoutHandle = await exec.stdout();
    const stderrHandle = await exec.stderr().catch(() => null);

    const exitListeners = new Set<
      (info: { code: number | null; signal: string | null }) => void
    >();
    const notifyExit = (info: {
      code: number | null;
      signal: string | null;
    }) => {
      for (const cb of exitListeners) cb(info);
    };

    void exec
      .wait()
      .then((res: { exitCode: number }) => {
        notifyExit({ code: res.exitCode, signal: null });
      })
      .catch((err: unknown) => {
        this.opts.log("boxlite execution wait failed", { err: String(err) });
        notifyExit({ code: null, signal: null });
      });

    const encoder = new TextEncoder();
    const toReadable = (next: () => Promise<string | null>) =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const line = await next();
          if (line === null) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(line));
        },
      });

    let closed = false;
    const kill = async () => {
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

      try {
        const killer = await nativeBox.exec(
          "sh",
          ["-c", killScript, "sh", pidFile],
          undefined,
          false,
        );
        await killer.wait().catch(() => {});
      } catch (err) {
        this.opts.log("boxlite kill failed", { err: String(err) });
      }
    };

    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await stdinHandle.write(Buffer.from(chunk));
        },
      }),
      stdout: toReadable(() => stdoutHandle.next()),
      stderr: stderrHandle ? toReadable(() => stderrHandle.next()) : undefined,
      close: async () => {
        if (closed) return;
        closed = true;
        await kill();
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };
  }

  async stopBox(): Promise<void> {
    const box = this.box;
    this.box = null;
    this.boxMeta = null;
    if (!box) return;
    try {
      await box.stop();
    } catch (err) {
      this.opts.log("boxlite stop failed", { err: String(err) });
    }
  }
}
