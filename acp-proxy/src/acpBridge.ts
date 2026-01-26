import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type SessionUpdateFn = (sessionId: string, update: acp.SessionNotification["update"]) => void;

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export class AcpBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private initialized = false;
  private lastInitResult: acp.InitializeResponse | null = null;

  constructor(
    private readonly opts: {
      command: string[];
      cwd: string;
      log: Logger;
      onSessionUpdate: SessionUpdateFn;
    },
  ) {}

  private kill() {
    const proc = this.proc;
    this.proc = null;
    this.conn = null;
    this.initialized = false;
    this.lastInitResult = null;
    if (proc && !proc.killed) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }
  }

  private ensureSpawned() {
    if (this.proc && this.conn) return;

    if (!this.opts.command.length) throw new Error("agent_command 为空");
    const [rawCmd, ...args] = this.opts.command;

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

    this.opts.log("spawn acp agent", { cmd: spawnCmd, args: spawnArgs, cwd: this.opts.cwd });
    const proc = spawn(spawnCmd, spawnArgs, { cwd: this.opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    proc.on("exit", (code, signal) => {
      this.opts.log("acp agent exited", { code, signal });
      this.kill();
    });
    proc.on("error", (err) => {
      this.opts.log("acp agent error", { err: String(err) });
      this.kill();
    });

    const input = Writable.toWeb(proc.stdin);
    const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;

    const stream = acp.ndJsonStream(input, output);

    const clientImpl: acp.Client = {
      requestPermission: async (params) => {
        const preferred =
          params.options.find((o) => o.kind === "allow_once") ?? params.options[0] ?? null;
        if (!preferred) {
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: preferred.optionId } };
      },
      sessionUpdate: async (params) => {
        this.opts.onSessionUpdate(params.sessionId, params.update);
      },
      readTextFile: async (_params) => {
        return { content: "" };
      },
      writeTextFile: async (_params) => {
        return {};
      },
    };

    this.proc = proc;
    this.conn = new acp.ClientSideConnection((_agent) => clientImpl, stream);
  }

  async ensureInitialized(): Promise<acp.InitializeResponse> {
    this.ensureSpawned();
    if (!this.conn) throw new Error("ACP connection not ready");
    if (this.initialized && this.lastInitResult) return this.lastInitResult;

    const init = await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "acp-proxy", title: "ACP Proxy", version: "0.2.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    this.initialized = true;
    this.lastInitResult = init;
    return init;
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    this.ensureSpawned();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    return await this.conn.newSession({ cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<boolean> {
    this.ensureSpawned();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();

    try {
      await this.conn.loadSession({ sessionId, cwd, mcpServers: [] });
      return true;
    } catch {
      return false;
    }
  }

  async prompt(sessionId: string, prompt: string): Promise<acp.PromptResponse> {
    this.ensureSpawned();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    return await this.conn.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
  }
}
