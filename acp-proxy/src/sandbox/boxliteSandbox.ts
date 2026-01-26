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
    // @ts-expect-error - optional dependency (only needed when sandbox.provider=boxlite_oci)
    return await import("@boxlite-ai/boxlite");
  } catch (errA) {
    try {
      // @ts-expect-error - optional dependency (package name differs by release channel)
      return await import("boxlite");
    } catch (errB) {
      throw new Error(
        "未安装 BoxLite Node SDK。请在 WSL2/Linux/macOS(Apple Silicon) 环境执行: pnpm -C acp-proxy add @boxlite-ai/boxlite（或 pnpm -C acp-proxy add boxlite）",
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
    const box = await runtime.create(boxOpts, null);

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
        }
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };

    return handle;
  }
}
