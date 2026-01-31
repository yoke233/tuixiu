import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SkillsCliRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type SkillsCliRunner = {
  run: (opts: { args: string[]; cwd: string; timeoutMs: number }) => Promise<SkillsCliRunResult>;
  withTempDir: <T>(task: (cwd: string) => Promise<T>) => Promise<T>;
};

export function createNpxSkillsCliRunner(opts: {
  npxPackageSpec: string;
  defaultTimeoutMs: number;
}): SkillsCliRunner {
  const npxPackageSpec = opts.npxPackageSpec.trim();
  if (!npxPackageSpec) throw new Error("npxPackageSpec 为空");

  function resolveNpxCommand(): { cmd: string; argsPrefix: string[] } {
    if (process.platform === "win32") {
      const comspec = String(process.env.ComSpec ?? "").trim();
      // Windows cannot exec `.cmd` directly; use cmd.exe /c npx ... instead.
      return { cmd: comspec || "cmd.exe", argsPrefix: ["/d", "/s", "/c", "npx"] };
    }
    return { cmd: "npx", argsPrefix: [] };
  }

  async function withTempDir<T>(task: (cwd: string) => Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skills-"));
    try {
      return await task(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function run(cmdOpts: { args: string[]; cwd: string; timeoutMs: number }): Promise<SkillsCliRunResult> {
    const timeoutMs =
      Number.isFinite(cmdOpts.timeoutMs) && cmdOpts.timeoutMs > 0 ? cmdOpts.timeoutMs : opts.defaultTimeoutMs;

    const { cmd, argsPrefix } = resolveNpxCommand();

    const proc = spawn(
      cmd,
      [...argsPrefix, "--yes", npxPackageSpec, ...cmdOpts.args],
      {
        cwd: cmdOpts.cwd,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          npm_config_color: "false",
          npm_config_update_notifier: "false",
        },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => {
      stdout += String(c ?? "");
    });
    proc.stderr.on("data", (c) => {
      stderr += String(c ?? "");
    });

    let spawnError: unknown = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);
    (timer as any).unref?.();

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("exit", (code) => resolve(typeof code === "number" ? code : null));
      proc.on("error", (e) => {
        spawnError = e;
        resolve(null);
      });
    }).finally(() => clearTimeout(timer));

    if (spawnError) {
      const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
      stderr = stderr ? `${stderr}\n${msg}` : msg;
    }

    return { stdout, stderr, exitCode, timedOut };
  }

  return { run, withTempDir };
}
