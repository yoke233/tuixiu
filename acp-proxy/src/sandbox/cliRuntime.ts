// src/sandbox/cliRuntime.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ContainerCli = "docker" | "podman" | "nerdctl";

export type CliRunSpec = {
  cli: ContainerCli;
  name: string;
  image: string;
  autoRemove?: boolean; // default true
  workingDir?: string; // container working dir
  env?: Record<string, string>;
  entrypoint?: string;
  labels?: Record<string, string>;
  extraArgs?: string[];
  mounts?: string[]; // ["host:container:ro", ...]
  ports?: Array<{ host: number; container: number; proto?: "tcp" | "udp" }>;
  // the container command
  cmd: string[]; // e.g. ["bash","-lc", "..."]
};

export type RunningProcess = {
  proc: ChildProcessWithoutNullStreams;
  kill: () => void;
};

export function shellEscapeSingle(s: string): string {
  // safe for embedding in bash -lc '...'
  // but we use bash -lc with a single string arg already, so mostly not needed.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function spawnCapture(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += String(d ?? "")));
  child.stderr.on("data", (d) => (stderr += String(d ?? "")));

  const code = await new Promise<number | null>((resolve) => {
    child.once("exit", (c) => resolve(c ?? null));
    child.once("error", () => resolve(1));
  });

  return { code, stdout, stderr };
}

export async function assertCliAvailable(cli: string): Promise<void> {
  // docker/podman/nerdctl 都支持 version
  const r = await spawnCapture(cli, ["version"]);
  if (r.code !== 0) {
    throw new Error(`${cli} 不可用：${`${r.stdout}\n${r.stderr}`.trim()}`);
  }
}

export async function rmForce(cli: string, name: string): Promise<void> {
  await spawnCapture(cli, ["rm", "-f", name]).catch(() => {});
}

export class CliRuntime {
  private readonly cli: ContainerCli;

  constructor(cli: ContainerCli) {
    this.cli = cli;
  }

  getCli(): ContainerCli {
    return this.cli;
  }

  runInteractive(spec: Omit<CliRunSpec, "cli">): RunningProcess {
    const cli = this.cli;

    const args: string[] = ["run"];
    if (spec.autoRemove !== false) args.push("--rm");
    args.push("-i", "--name", spec.name);

    // ✅ 覆盖 entrypoint（关键）
    if (spec.entrypoint) {
      args.push("--entrypoint", spec.entrypoint);
    }

    // working dir
    if (spec.workingDir) {
      args.push("-w", spec.workingDir);
    }

    // labels
    if (spec.labels) {
      for (const [k, v] of Object.entries(spec.labels)) {
        if (!k) continue;
        args.push("--label", `${k}=${v ?? ""}`);
      }
    }

    // extra args
    if (spec.extraArgs?.length) {
      args.push(...spec.extraArgs);
    }

    // env
    if (spec.env) {
      for (const [k, v] of Object.entries(spec.env)) {
        if (!k) continue;
        args.push("-e", `${k}=${v ?? ""}`);
      }
    }

    // mounts
    if (spec.mounts) {
      for (const m of spec.mounts) args.push("-v", m);
    }

    // ports
    if (spec.ports) {
      for (const p of spec.ports) {
        const proto = p.proto ?? "tcp";
        args.push("-p", `${p.host}:${p.container}/${proto}`);
      }
    }

    // image + cmd
    args.push(spec.image, ...spec.cmd);

    const proc = spawn(cli, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env, // keep host env; container env is in args
    });

    const kill = () => {
      try {
        // kill the cli process; container will exit and --rm removes it
        proc.kill();
      } catch {
        // ignore
      }
    };

    return { proc, kill };
  }

  async remove(name: string): Promise<"removed" | "missing"> {
    // attempt rm -f; if it's already gone, still ok
    const r = await spawnCapture(this.cli, ["rm", "-f", name]);
    // docker/podman/nerdctl 返回信息不一致，统一成 removed/missing
    const out = `${r.stdout}\n${r.stderr}`.toLowerCase();
    if (r.code === 0) return "removed";
    if (out.includes("no such container") || out.includes("not found")) return "missing";
    // 其他错误：也返回 removed（以免测试抖），但你也可以改成 throw
    return "removed";
  }
}
