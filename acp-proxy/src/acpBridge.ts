import * as acp from "@agentclientprotocol/sdk";

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AcpTransport, AgentLauncher } from "./launchers/types.js";
import type { SandboxProvider } from "./sandbox/types.js";

type SessionUpdateFn = (sessionId: string, update: acp.SessionNotification["update"]) => void;

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type TerminalExitStatus = { exitCode?: number | null; signal?: string | null };

type ManagedTerminal = {
  sessionId: string;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus: TerminalExitStatus | null;
  exitPromise: Promise<TerminalExitStatus>;
  kill: () => Promise<void>;
  release: () => Promise<void>;
};

function isAuthRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as any).code;
  return code === -32000;
}

function trimToByteLimit(value: string, limit: number): { value: string; truncated: boolean } {
  if (limit <= 0) return { value: "", truncated: true };
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { value, truncated: false };

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const slice = value.slice(mid);
    if (Buffer.byteLength(slice, "utf8") > limit) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let trimmed = value.slice(low);
  while (trimmed && Buffer.byteLength(trimmed, "utf8") > limit) {
    trimmed = trimmed.slice(1);
  }
  return { value: trimmed, truncated: true };
}

function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): string {
  const base = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(base, requestedPath);

  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  const within =
    process.platform === "win32"
      ? resolved.toLowerCase().startsWith(baseWithSep.toLowerCase()) ||
        resolved.toLowerCase() === base.toLowerCase()
      : resolved.startsWith(baseWithSep) || resolved === base;

  if (!within)
    throw acp.RequestError.invalidParams({
      path: "Path is outside workspace root",
    });
  return resolved;
}

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
      sandbox: SandboxProvider;
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

    for (const term of this.terminals.values()) {
      void term.release().catch(() => {});
    }
    this.terminals.clear();
  }

  private readonly terminals = new Map<string, ManagedTerminal>();

  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      const methodId = this.lastInitResult?.authMethods?.[0]?.id ?? "";
      if (!methodId) throw err;
      await this.ensureConnected();
      if (!this.conn) throw new Error("ACP connection not ready");
      await this.conn.authenticate({ methodId });
      return await fn();
    }
  }

  private async readTextFileImpl(
    params: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    const resolved = resolveWorkspacePath(this.opts.cwd, params.path);
    let content: string;
    try {
      content = await fs.readFile(resolved, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") throw acp.RequestError.resourceNotFound(params.path);
      throw err;
    }

    const lineRaw = params.line ?? null;
    const limitRaw = params.limit ?? null;
    if (lineRaw == null && limitRaw == null) return { content };

    const start = Math.max(0, Number.isFinite(lineRaw) ? Math.max(0, (lineRaw as number) - 1) : 0);
    const limit = Number.isFinite(limitRaw) ? Math.max(0, limitRaw as number) : null;
    if (limit === 0) return { content: "" };

    const lines = content.split(/\r?\n/g);
    const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
    return { content: lines.slice(start, end).join("\n") };
  }

  private async writeTextFileImpl(
    params: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    const resolved = resolveWorkspacePath(this.opts.cwd, params.path);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, params.content ?? "", "utf8");
    return {};
  }

  private async createTerminalImpl(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const terminalId = randomUUID();
    const cwd = params.cwd?.trim() ? params.cwd.trim() : this.opts.cwd;
    const resolvedCwd = resolveWorkspacePath(this.opts.cwd, cwd);

    const env: Record<string, string> = {};
    for (const item of params.env ?? []) {
      if (!item?.name?.trim()) continue;
      env[item.name] = item.value ?? "";
    }

    const outputByteLimitRaw = params.outputByteLimit ?? null;
    const outputByteLimit = Number.isFinite(outputByteLimitRaw as number)
      ? Math.max(4_096, Math.min(64 * 1024 * 1024, outputByteLimitRaw as number))
      : 2 * 1024 * 1024;

    const command = [params.command, ...(params.args ?? [])].filter(
      (x) => typeof x === "string" && x.length,
    );
    if (!command.length) throw acp.RequestError.invalidParams({ command: "command is required" });

    const handle = await this.opts.sandbox.runProcess({
      command,
      cwd: resolvedCwd,
      env: Object.keys(env).length ? env : undefined,
    });

    let resolveExit: (value: TerminalExitStatus) => void;
    const exitPromise = new Promise<TerminalExitStatus>((resolve) => {
      resolveExit = resolve;
    });

    const term: ManagedTerminal = {
      sessionId: params.sessionId,
      output: "",
      truncated: false,
      outputByteLimit,
      exitStatus: null,
      exitPromise,
      kill: async () => {
        await handle.close();
      },
      release: async () => {
        await handle.close();
      },
    };

    const appendOutput = (chunk: string) => {
      if (!chunk) return;
      term.output += chunk;
      const trimmed = trimToByteLimit(term.output, term.outputByteLimit);
      term.output = trimmed.value;
      term.truncated = term.truncated || trimmed.truncated;
    };

    const consumeStream = (
      stream: ReadableStream<Uint8Array> | undefined,
      label: "stdout" | "stderr",
    ) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      void (async () => {
        const reader = stream.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const text = decoder.decode(value, { stream: true });
            appendOutput(text);
          }
          appendOutput(decoder.decode());
        } catch (err) {
          this.opts.log("terminal stream read failed", {
            terminalId,
            label,
            err: String(err),
          });
        } finally {
          reader.releaseLock();
        }
      })();
    };

    consumeStream(handle.stdout, "stdout");
    consumeStream(handle.stderr, "stderr");

    handle.onExit?.((info) => {
      const exitStatus: TerminalExitStatus = {
        exitCode: info.code,
        signal: info.signal,
      };
      term.exitStatus = exitStatus;
      resolveExit(exitStatus);
    });

    this.terminals.set(terminalId, term);

    return { terminalId };
  }

  private getTerminalOrThrow(params: { terminalId: string }): ManagedTerminal {
    const term = this.terminals.get(params.terminalId);
    if (!term) throw acp.RequestError.resourceNotFound(params.terminalId);
    return term;
  }

  private async terminalOutputImpl(
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    const term = this.getTerminalOrThrow(params);
    return {
      output: term.output,
      truncated: term.truncated,
      exitStatus: term.exitStatus
        ? {
            exitCode: term.exitStatus.exitCode ?? null,
            signal: term.exitStatus.signal ?? null,
          }
        : null,
    };
  }

  private async waitForTerminalExitImpl(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const term = this.getTerminalOrThrow(params);
    const status = term.exitStatus ?? (await term.exitPromise);
    return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
  }

  private async killTerminalImpl(
    params: acp.KillTerminalCommandRequest,
  ): Promise<acp.KillTerminalResponse> {
    const term = this.getTerminalOrThrow(params);
    await term.kill();
    return {};
  }

  private async releaseTerminalImpl(
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    const term = this.getTerminalOrThrow(params);
    await term.release();
    this.terminals.delete(params.terminalId);
    return {};
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
          // Auto-approve all permission requests
          // Priority: allow_always > allow_once > first option
          const preferred =
            params.options.find((o) => o.kind === "allow_always") ??
            params.options.find((o) => o.kind === "allow_once") ??
            params.options[0] ??
            null;

          if (!preferred) {
            return { outcome: { outcome: "cancelled" } };
          }
          return {
            outcome: { outcome: "selected", optionId: preferred.optionId },
          };
        },
        sessionUpdate: async (params) => {
          this.opts.onSessionUpdate(params.sessionId, params.update);
        },
        readTextFile: async (params) => await this.readTextFileImpl(params),
        writeTextFile: async (params) => await this.writeTextFileImpl(params),
        createTerminal: async (params) => await this.createTerminalImpl(params),
        terminalOutput: async (params) => await this.terminalOutputImpl(params),
        waitForTerminalExit: async (params) => await this.waitForTerminalExitImpl(params),
        killTerminal: async (params) => await this.killTerminalImpl(params),
        releaseTerminal: async (params) => await this.releaseTerminalImpl(params),
        extMethod: async (method, params) => {
          this.opts.log("acp extMethod (unhandled)", { method, params });
          return {};
        },
        extNotification: async (method, params) => {
          this.opts.log("acp extNotification (unhandled)", { method, params });
        },
      };

      this.transport = transport;
      this.conn = new acp.ClientSideConnection(() => clientImpl, stream);
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
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
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
    const res = await this.withAuthRetry(() => this.conn!.newSession({ cwd, mcpServers: [] }));

    // Auto-switch to "code" mode if available
    if (res.modes && res.modes.availableModes.some((m) => m.id === "code")) {
      try {
        await this.setSessionMode(res.sessionId, "code");
      } catch (err) {
        this.opts.log("failed to set session mode to code", {
          err: String(err),
        });
      }
    }

    return res;
  }

  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse | null> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();

    try {
      const res = await this.withAuthRetry(() =>
        this.conn!.loadSession({ sessionId, cwd, mcpServers: [] }),
      );
      return res;
    } catch {
      return null;
    }
  }

  async prompt(sessionId: string, prompt: string): Promise<acp.PromptResponse> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    return await this.withAuthRetry(() =>
      this.conn!.prompt({
        sessionId,
        prompt: [{ type: "text", text: prompt }],
      }),
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    await this.conn.cancel({ sessionId });
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    await this.withAuthRetry(() => this.conn!.setSessionMode({ sessionId, modeId }));
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.ensureConnected();
    if (!this.conn) throw new Error("ACP connection not ready");
    await this.ensureInitialized();
    await this.withAuthRetry(() => this.conn!.setSessionModel({ sessionId, modelId }));
  }

  close(): void {
    this.kill();
  }
}
