import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Buffer } from "node:buffer";

import type { ProcessHandle, RunProcessOpts, SandboxProvider } from "./types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type BoxliteVolume = { hostPath: string; guestPath: string; readOnly?: boolean };

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
    throw new Error("BoxLite 不支持 Windows 原生运行，请在 WSL2/Linux 或 macOS(Apple Silicon) 上使用 boxlite_oci");
  }

  if (process.platform === "darwin") {
    if (process.arch !== "arm64") {
      throw new Error("BoxLite 仅支持 macOS Apple Silicon(arm64)。Intel Mac 请使用 sandbox.provider=host_process 或在 Linux/WSL2 上运行");
    }
    return;
  }

  if (process.platform === "linux") {
    try {
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
    } catch {
      throw new Error("BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm");
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

function toEnvArray(env: Record<string, string> | undefined): Array<[string, string]> | undefined {
  if (!env) return undefined;
  const entries = Object.entries(env).filter(([k]) => k.trim());
  if (!entries.length) return undefined;
  return entries;
}

export class BoxliteSandbox implements SandboxProvider {
  private box: any | null = null;

  constructor(private readonly opts: { log: Logger; config: BoxliteSandboxConfig }) {}

  async runProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    await assertBoxliteSupportedPlatform();

    const cfg = this.opts.config;
    if (!cfg.image.trim()) throw new Error("BoxLite 配置缺失：sandbox.boxlite.image");

    const mod = await importBoxliteModule();
    const JsBoxlite = mod.JsBoxlite ?? mod.Boxlite ?? mod.default?.JsBoxlite ?? null;
    if (!JsBoxlite || typeof JsBoxlite.withDefaultConfig !== "function") {
      throw new Error("BoxLite SDK API 不匹配：未找到 JsBoxlite.withDefaultConfig()");
    }

    const runtime = JsBoxlite.withDefaultConfig();

    const envForProc = { ...cfg.env, ...opts.env };

    const boxOpts = {
      image: cfg.image,
      cpus: cfg.cpus,
      memoryMib: cfg.memoryMib,
      autoRemove: true,
      workingDir: cfg.workingDir?.trim() ? cfg.workingDir.trim() : opts.cwd,
      env: Object.entries(envForProc).map(([key, value]) => ({ key, value })),
      volumes: cfg.volumes,
    };

    this.opts.log("boxlite create", { image: cfg.image, workingDir: boxOpts.workingDir });
    if (this.box) {
      try {
        await this.box.stop();
      } catch (err) {
        this.opts.log("boxlite stop previous box failed", { err: String(err) });
      } finally {
        this.box = null;
      }
    }

    const box = await runtime.create(boxOpts, null);
    this.box = box;

    if (!opts.command.length) throw new Error("agent_command 为空");
    const [cmd, ...args] = opts.command;

    this.opts.log("boxlite exec acp agent", { cmd, args, cwd: boxOpts.workingDir });

    const exec = await box.exec(cmd, args, toEnvArray(envForProc), false);

    const stdinHandle = await exec.stdin();
    const stdoutHandle = await exec.stdout();
    const stderrHandle = await exec.stderr().catch(() => null);

    const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
    const notifyExit = (info: { code: number | null; signal: string | null }) => {
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
          controller.enqueue(encoder.encode(`${line}\n`));
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
        }
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };

    return handle;
  }

  async execProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    await assertBoxliteSupportedPlatform();
    const box = this.box;
    if (!box) throw new Error("BoxLite box 尚未创建，无法 exec。请先启动 ACP agent");

    const cfg = this.opts.config;
    const envForProc = { ...cfg.env, ...opts.env };

    if (!opts.command.length) throw new Error("command 为空");
    const [cmd, ...args] = opts.command;

    this.opts.log("boxlite exec", { cmd, args });

    const exec = await box.exec(cmd, args, toEnvArray(envForProc), false);

    const stdinHandle = await exec.stdin();
    const stdoutHandle = await exec.stdout();
    const stderrHandle = await exec.stderr().catch(() => null);

    const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
    const notifyExit = (info: { code: number | null; signal: string | null }) => {
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
          controller.enqueue(encoder.encode(`${line}\n`));
        },
      });

    return {
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          await stdinHandle.write(Buffer.from(chunk));
        },
      }),
      stdout: toReadable(() => stdoutHandle.next()),
      stderr: stderrHandle ? toReadable(() => stderrHandle.next()) : undefined,
      close: async () => {
        // best-effort: BoxLite Execution 暂未暴露 kill/interrupt；这里不强制 stop 整个 box，避免影响 ACP agent。
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };
  }

  async stopBox(): Promise<void> {
    const box = this.box;
    this.box = null;
    if (!box) return;
    try {
      await box.stop();
    } catch (err) {
      this.opts.log("boxlite stop failed", { err: String(err) });
    }
  }
}
