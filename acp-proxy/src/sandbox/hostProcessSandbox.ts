import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import type { ProcessHandle, RunProcessOpts, SandboxProvider } from "./types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export class HostProcessSandbox implements SandboxProvider {
  constructor(private readonly opts: { log: Logger }) {}

  async runProcess(opts: RunProcessOpts): Promise<ProcessHandle> {
    if (!opts.command.length) throw new Error("agent_command 为空");
    const [rawCmd, ...args] = opts.command;

    const lower = rawCmd.toLowerCase();
    const useCmdShim =
      process.platform === "win32" &&
      (lower === "npx" ||
        lower === "npm" ||
        lower === "pnpm" ||
        lower === "yarn" ||
        lower.endsWith(".cmd") ||
        lower.endsWith(".bat"));

    const spawnCmd = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : rawCmd;
    const spawnArgs = useCmdShim ? ["/d", "/s", "/c", rawCmd, ...args] : args;

    this.opts.log("spawn acp agent", { cmd: spawnCmd, args: spawnArgs, cwd: opts.cwd });

    const proc = spawn(spawnCmd, spawnArgs, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
    const notifyExit = (info: { code: number | null; signal: string | null }) => {
      for (const cb of exitListeners) cb(info);
    };

    proc.on("exit", (code, signal) => {
      notifyExit({ code, signal });
    });
    proc.on("error", (err) => {
      this.opts.log("acp agent error", { err: String(err) });
      notifyExit({ code: null, signal: null });
    });

    return {
      stdin: Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>,
      close: async () => {
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        await new Promise<void>((resolve) => {
          proc.once("exit", () => resolve());
          try {
            proc.kill();
          } catch {
            resolve();
          }
        });
      },
      onExit: (cb) => {
        exitListeners.add(cb);
      },
    };
  }
}
