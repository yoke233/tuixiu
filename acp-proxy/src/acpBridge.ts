import * as acp from "@agentclientprotocol/sdk";

import type { AcpTransport, AgentLauncher } from "./launchers/types.js";

type SessionUpdateFn = (sessionId: string, update: acp.SessionNotification["update"]) => void;

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export class AcpBridge {
  private transport: AcpTransport | null = null;
  private conn: acp.ClientSideConnection | null = null;
  private initialized = false;
  private lastInitResult: acp.InitializeResponse | null = null;
  private connecting: Promise<void> | null = null;
  private initializing: Promise<acp.InitializeResponse> | null = null;

  constructor(
    private readonly opts: {
      launcher: AgentLauncher;
      cwd: string;
      log: Logger;
      onSessionUpdate: SessionUpdateFn;
    },
  ) {}

  private kill() {
    const transport = this.transport;
    this.transport = null;
    this.conn = null;
    this.initialized = false;
    this.lastInitResult = null;
    this.connecting = null;
    this.initializing = null;
    if (transport) void transport.close().catch(() => {});
  }

  private async ensureConnected(): Promise<void> {
    if (this.transport && this.conn) return;

    if (this.connecting) {
      await this.connecting;
      return;
    }

    const p = (async () => {
      if (this.transport && this.conn) return;

      const transport = await this.opts.launcher.launch({ cwd: this.opts.cwd });
      transport.onExit?.((info) => {
        this.opts.log("acp agent exited", info);
        this.kill();
      });

      const stream = acp.ndJsonStream(transport.input, transport.output);

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

      this.transport = transport;
      this.conn = new acp.ClientSideConnection((_agent) => clientImpl, stream);
    })();

    this.connecting = p;
    try {
      await p;
    } finally {
      if (this.connecting === p) this.connecting = null;
    }
  }

  async ensureInitialized(): Promise<acp.InitializeResponse> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    if (this.initialized && this.lastInitResult) return this.lastInitResult;

    if (this.initializing) return await this.initializing;

    const p = (async () => {
      if (!this.conn) throw new Error("ACP connection not ready");
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
    })();

    this.initializing = p;
    try {
      return await p;
    } finally {
      if (this.initializing === p) this.initializing = null;
    }
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    return await this.conn.newSession({ cwd, mcpServers: [] });
  }

  async loadSession(sessionId: string, cwd: string): Promise<boolean> {
    await this.ensureConnected();
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
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    return await this.conn.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
  }
}
