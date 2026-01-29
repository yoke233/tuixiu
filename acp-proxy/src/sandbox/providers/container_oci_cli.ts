// src/sandbox/providers/container_oci_cli.ts
import type WebSocket from "ws";
import { CliRuntime, type ContainerCli } from "../cliRuntime.js";

export type SandboxInit = {
  script?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
};

export type ContainerOciConfig = {
  provider: "container_oci";
  runtime: ContainerCli; // docker|podman|nerdctl
  image: string;
  workingDir: string; // e.g. /workspace
  terminalEnabled?: boolean;
  mounts?: string[];
  ports?: Array<{ host: number; container: number; proto?: "tcp" | "udp" }>;
};

type AgentCommand = string[]; // e.g. ["node","-e", "...."]

type OpenArgs = {
  run_id: string;
  instance_name: string;
  init?: SandboxInit;
  agent_command: AgentCommand;
};

type WireSend = (obj: any) => void;

function buildBashScript(workingDir: string, init?: SandboxInit, agentCmd?: string[]): string {
  // 注意：workingDir 不存在会导致 -w 失败/行为不一致，所以在脚本里 mkdir -p
  const initScript = (init?.script ?? "").trim();
  const cmd = agentCmd && agentCmd.length > 0 ? agentCmd : ["true"];

  // 在 bash -lc 里 exec 需要拼成一段命令：exec <arg1> <arg2> ...
  // 用 JSON.stringify 做简单转义（在 bash 里当作字面量还不够完美，但对 node -e 这类够用）
  // 更严格你可以实现 shell-quote，这里走“工程够用”的方式：每个参数单引号包裹。
  const quote = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const execLine = ["exec", ...cmd.map(quote)].join(" ");

  const lines = [
    "set -e",
    `mkdir -p ${quote(workingDir)}`,
    initScript ? initScript : "",
    execLine,
  ].filter(Boolean);

  return lines.join("\n");
}

export class ContainerOciCliProvider {
  private readonly cfg: ContainerOciConfig;
  private readonly runtime: CliRuntime;

  // 一个 instanceName 对应一个 running process
  private readonly procs = new Map<
    string,
    { kill: () => void; stdin: NodeJS.WritableStream; onExit: Promise<number | null> }
  >();

  constructor(cfg: ContainerOciConfig) {
    this.cfg = cfg;
    this.runtime = new CliRuntime(cfg.runtime);
  }

  async open(ws: WebSocket, send: WireSend, args: OpenArgs): Promise<void> {
    const { run_id, instance_name, init, agent_command } = args;

    // 如果同名已存在，先强制清掉（避免 e2e 抖）
    await this.runtime.remove(instance_name).catch(() => {});

    const bashScript = buildBashScript(this.cfg.workingDir, init, agent_command);

    // init env 仅用于 init+agent
    const env = { ...(init?.env ?? {}) };

    const running = this.runtime.runInteractive({
      name: instance_name,
      image: this.cfg.image,
      workingDir: this.cfg.workingDir,
      env,
      mounts: this.cfg.mounts,
      ports: this.cfg.ports,
      cmd: ["bash", "-lc", bashScript],
    });

    const proc = running.proc;

    // 把 stdout/stderr 逐行发回 orchestrator（你测试里就是从这里抓 INIT_ENV=ok）
    const forward = (text: string) => {
      // 你项目里消息格式可能不一样；这里按你的测试 predicate：
      // type="agent_update", run_id=run_id, content.text 包含日志
      send({
        type: "agent_update",
        run_id,
        content: { type: "text", text },
      });
    };

    // 行缓冲（避免半行）
    let outBuf = "";
    let errBuf = "";

    proc.stdout.on("data", (d) => {
      outBuf += String(d ?? "");
      while (true) {
        const idx = outBuf.indexOf("\n");
        if (idx < 0) break;
        const line = outBuf.slice(0, idx).replace(/\r$/, "");
        outBuf = outBuf.slice(idx + 1);
        if (line.length) forward(line);
      }
    });

    proc.stderr.on("data", (d) => {
      errBuf += String(d ?? "");
      while (true) {
        const idx = errBuf.indexOf("\n");
        if (idx < 0) break;
        const line = errBuf.slice(0, idx).replace(/\r$/, "");
        errBuf = errBuf.slice(idx + 1);
        if (line.length) forward(line);
      }
    });

    const onExit = new Promise<number | null>((resolve) => {
      proc.once("exit", (c) => resolve(c ?? null));
      proc.once("error", () => resolve(1));
    });

    this.procs.set(instance_name, { kill: running.kill, stdin: proc.stdin, onExit });

    // 成功打开（你测试里等 acp_opened ok=true）
    send({ type: "acp_opened", run_id, ok: true });
  }

  sendToAgent(instance_name: string, data: string): void {
    const p = this.procs.get(instance_name);
    if (!p) throw new Error(`instance not found: ${instance_name}`);
    p.stdin.write(data);
  }

  async remove(instance_name: string): Promise<{ ok: boolean; status: "removed" | "missing" }> {
    const p = this.procs.get(instance_name);
    if (p) {
      try {
        p.kill();
      } catch {}
      this.procs.delete(instance_name);
    }
    const status = await this.runtime.remove(instance_name);
    return { ok: true, status };
  }

  async waitExit(instance_name: string): Promise<number | null> {
    const p = this.procs.get(instance_name);
    if (!p) return null;
    return await p.onExit;
  }
}
