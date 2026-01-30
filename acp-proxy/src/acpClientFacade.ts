import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { FS_READ_SCRIPT, FS_WRITE_SCRIPT } from "./utils/fsScripts.js";

import type { SandboxInstanceProvider } from "./sandbox/types.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

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

type PermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
  [k: string]: unknown;
};

type PermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

type PermissionDecision =
  | { outcome: "selected"; optionId?: string | null }
  | { outcome: "cancelled" };

type PermissionRequest = {
  requestId: string;
  sessionId: string | null;
  toolCall: unknown;
  options: PermissionOption[];
};

type PendingPermission = {
  options: PermissionOption[];
  resolve: (outcome: PermissionOutcome) => void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolveWorkspaceGuestPath(opts: {
  workspaceGuestRoot: string;
  requestedPath: string;
}): string {
  const root = opts.workspaceGuestRoot.trim() ? opts.workspaceGuestRoot.trim() : "/workspace";
  const raw = opts.requestedPath.trim();
  if (!raw) throw new Error("path 为空");

  const candidate = raw.startsWith("/") ? raw : path.posix.join(root, raw);
  const normalized = path.posix.normalize(candidate);
  const rootNorm = path.posix.normalize(root);
  const rootWithSep = rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`;
  if (normalized === rootNorm || normalized.startsWith(rootWithSep)) return normalized;
  throw new Error("path is outside workspace root");
}

async function readAllText(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
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

function errorResponse(id: JsonRpcId, err: unknown): JsonRpcResponse {
  if (err && typeof err === "object") {
    const codeRaw = (err as any).code;
    const messageRaw = (err as any).message;
    const dataRaw = (err as any).data;
    if (typeof codeRaw === "number" && typeof messageRaw === "string") {
      return {
        jsonrpc: "2.0",
        id,
        error:
          dataRaw === undefined
            ? { code: codeRaw, message: messageRaw }
            : { code: codeRaw, message: messageRaw, data: dataRaw },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: String(err) },
  };
}

function okResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export class AcpClientFacade {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(
    private readonly opts: {
      runId: string;
      instanceName: string;
      workspaceGuestRoot: string;
      sandbox: SandboxInstanceProvider;
      log: Logger;
      terminalEnabled: boolean;
      permissionAsk?: boolean;
      onPermissionRequest?: (req: PermissionRequest) => void;
    },
  ) {}

  private async execToText(opts: {
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
    stdinText?: string;
  }): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
    const handle = await this.opts.sandbox.execProcess({
      instanceName: this.opts.instanceName,
      command: opts.command,
      cwdInGuest: opts.cwdInGuest,
      env: opts.env,
    });

    let resolveExit!: (info: { code: number | null; signal: string | null }) => void;
    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    handle.onExit?.((info) => resolveExit(info));
    if (!handle.onExit) resolveExit({ code: null, signal: null });

    const encoder = new TextEncoder();
    const stdinWriter = handle.stdin.getWriter();
    try {
      if (typeof opts.stdinText === "string") {
        await stdinWriter.write(encoder.encode(opts.stdinText));
      }
      await stdinWriter.close();
    } catch {
      try {
        stdinWriter.releaseLock();
      } catch {
        // ignore
      }
    }

    const [stdout, stderr, exit] = await Promise.all([
      readAllText(handle.stdout),
      readAllText(handle.stderr),
      exitP,
    ]);

    return { stdout, stderr, code: exit.code, signal: exit.signal };
  }

  private pickDefaultPermissionOutcome(options: PermissionOption[]): PermissionOutcome {
    const preferred = options.find((o) => o.kind === "allow_once") ?? options[0] ?? null;
    const optionId = preferred?.optionId?.trim() ?? "";
    return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
  }

  private normalizePermissionDecision(
    options: PermissionOption[],
    decision: PermissionDecision,
  ): PermissionOutcome {
    if (decision.outcome === "cancelled") return { outcome: "cancelled" };
    const optionId = typeof decision.optionId === "string" ? decision.optionId.trim() : "";
    if (optionId) {
      const matched = options.find((o) => o.optionId === optionId);
      if (matched) return { outcome: "selected", optionId: matched.optionId };
    }
    return this.pickDefaultPermissionOutcome(options);
  }

  private async waitForPermission(req: PermissionRequest): Promise<PermissionOutcome> {
    if (!req.options.length) {
      this.opts.log("permission request missing options", { runId: this.opts.runId });
      return { outcome: "cancelled" };
    }

    const requestId = req.requestId;
    if (this.pendingPermissions.has(requestId)) {
      this.opts.log("permission request already pending", { runId: this.opts.runId, requestId });
      return this.pickDefaultPermissionOutcome(req.options);
    }

    const outcome = new Promise<PermissionOutcome>((resolve) => {
      this.pendingPermissions.set(requestId, { options: req.options, resolve });
    });

    try {
      this.opts.onPermissionRequest?.(req);
    } catch (err) {
      this.opts.log("permission request handler failed", { runId: this.opts.runId, err: String(err) });
    }

    const res = await outcome;
    this.pendingPermissions.delete(requestId);
    return res;
  }

  resolvePermission(requestId: JsonRpcId, decision: PermissionDecision): boolean {
    const key = String(requestId);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return false;
    const outcome = this.normalizePermissionDecision(pending.options, decision);
    pending.resolve(outcome);
    this.pendingPermissions.delete(key);
    return true;
  }

  cancelPermissionRequest(requestId: JsonRpcId): boolean {
    return this.resolvePermission(requestId, { outcome: "cancelled" });
  }

  cancelAllPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      pending.resolve({ outcome: "cancelled" });
      this.pendingPermissions.delete(requestId);
    }
  }

  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const method = req.method;
    try {
      if (method === "session/request_permission") {
        const params = isRecord(req.params) ? req.params : {};
        const optionsRaw = Array.isArray((params as any).options)
          ? ((params as any).options as any[])
          : [];
        const options = optionsRaw
          .filter((o) => isRecord(o) && typeof (o as any).optionId === "string")
          .map((o) => o as PermissionOption);

        if (!this.opts.permissionAsk) {
          const outcome = this.pickDefaultPermissionOutcome(options);
          return okResponse(req.id, { outcome });
        }

        const sessionId =
          typeof (params as any).sessionId === "string" ? String((params as any).sessionId) : null;
        const toolCall = (params as any).toolCall;
        const requestId = String(req.id);

        const outcome = await this.waitForPermission({
          requestId,
          sessionId,
          toolCall,
          options,
        });

        return okResponse(req.id, { outcome });
      }

      if (method.startsWith("terminal/") && !this.opts.terminalEnabled) {
        throw { code: -32000, message: "terminal disabled" };
      }

      if (method === "fs/read_text_file") {
        if (!isRecord(req.params) || typeof req.params.path !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const guestPath = resolveWorkspaceGuestPath({
          workspaceGuestRoot: this.opts.workspaceGuestRoot,
          requestedPath: req.params.path,
        });

        const res = await this.execToText({
          command: ["sh", "-c", FS_READ_SCRIPT, "sh", guestPath],
          cwdInGuest: this.opts.workspaceGuestRoot,
        });
        if (res.code !== 0) {
          const errText = `${res.stdout}\n${res.stderr}`.toLowerCase();
          if (errText.includes("no such file") || errText.includes("not found")) {
            throw { code: -32004, message: "resource not found" };
          }
          throw new Error(`${res.stdout}\n${res.stderr}`.trim() || `exitCode=${res.code}`);
        }

        const content = res.stdout;

        const lineRaw = (req.params as any).line ?? null;
        const limitRaw = (req.params as any).limit ?? null;
        if (lineRaw == null && limitRaw == null) return okResponse(req.id, { content });

        const start = Math.max(0, Number.isFinite(lineRaw) ? Math.max(0, Number(lineRaw) - 1) : 0);
        const limit = Number.isFinite(limitRaw) ? Math.max(0, Number(limitRaw)) : null;
        if (limit === 0) return okResponse(req.id, { content: "" });

        const lines = content.split(/\r?\n/g);
        const end = limit == null ? lines.length : Math.min(lines.length, start + limit);
        return okResponse(req.id, { content: lines.slice(start, end).join("\n") });
      }

      if (method === "fs/write_text_file") {
        if (!isRecord(req.params) || typeof req.params.path !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const guestPath = resolveWorkspaceGuestPath({
          workspaceGuestRoot: this.opts.workspaceGuestRoot,
          requestedPath: req.params.path,
        });
        const content =
          typeof (req.params as any).content === "string" ? (req.params as any).content : "";

        const res = await this.execToText({
          command: [
            "sh",
            "-c",
            FS_WRITE_SCRIPT,
            "sh",
            guestPath,
          ],
          cwdInGuest: this.opts.workspaceGuestRoot,
          stdinText: content,
        });
        if (res.code !== 0) {
          throw new Error(`${res.stdout}\n${res.stderr}`.trim() || `exitCode=${res.code}`);
        }
        return okResponse(req.id, {});
      }

      if (method === "terminal/create") {
        if (!isRecord(req.params)) throw { code: -32602, message: "invalid params" };
        const params: any = req.params;
        const terminalId = randomUUID();
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";

        const cwdRaw =
          typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : ".";
        const cwd = resolveWorkspaceGuestPath({
          workspaceGuestRoot: this.opts.workspaceGuestRoot,
          requestedPath: cwdRaw,
        });

        const env: Record<string, string> = {};
        for (const item of params.env ?? []) {
          if (!item || typeof item !== "object") continue;
          const name = (item as any).name;
          if (typeof name !== "string" || !name.trim()) continue;
          env[name] = typeof (item as any).value === "string" ? (item as any).value : "";
        }

        const outputByteLimitRaw = params.outputByteLimit ?? null;
        const outputByteLimit = Number.isFinite(outputByteLimitRaw as number)
          ? Math.max(4_096, Math.min(64 * 1024 * 1024, Number(outputByteLimitRaw)))
          : 2 * 1024 * 1024;

        const command = [params.command, ...(params.args ?? [])].filter(
          (x: unknown) => typeof x === "string" && x.length,
        ) as string[];
        if (!command.length) throw { code: -32602, message: "command is required" };
        const handle = await this.opts.sandbox.execProcess({
          instanceName: this.opts.instanceName,
          command,
          cwdInGuest: cwd,
          env: Object.keys(env).length ? env : undefined,
        });

        let resolveExit: (value: TerminalExitStatus) => void;
        const exitPromise = new Promise<TerminalExitStatus>((resolve) => {
          resolveExit = resolve;
        });

        const term: ManagedTerminal = {
          sessionId,
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
                runId: this.opts.runId,
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
        return okResponse(req.id, { terminalId });
      }

      if (method === "terminal/output") {
        if (!isRecord(req.params) || typeof req.params.terminalId !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const term = this.terminals.get(req.params.terminalId);
        if (!term) throw { code: -32004, message: "resource not found" };

        return okResponse(req.id, {
          output: term.output,
          truncated: term.truncated,
          exitStatus: term.exitStatus
            ? {
                exitCode: term.exitStatus.exitCode ?? null,
                signal: term.exitStatus.signal ?? null,
              }
            : null,
        });
      }

      if (method === "terminal/wait_for_exit") {
        if (!isRecord(req.params) || typeof req.params.terminalId !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const term = this.terminals.get(req.params.terminalId);
        if (!term) throw { code: -32004, message: "resource not found" };

        const status = term.exitStatus ?? (await term.exitPromise);
        return okResponse(req.id, {
          exitCode: status.exitCode ?? null,
          signal: status.signal ?? null,
        });
      }

      if (method === "terminal/kill") {
        if (!isRecord(req.params) || typeof req.params.terminalId !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const term = this.terminals.get(req.params.terminalId);
        if (!term) throw { code: -32004, message: "resource not found" };
        await term.kill();
        return okResponse(req.id, {});
      }

      if (method === "terminal/release") {
        if (!isRecord(req.params) || typeof req.params.terminalId !== "string") {
          throw { code: -32602, message: "invalid params" };
        }
        const term = this.terminals.get(req.params.terminalId);
        if (!term) throw { code: -32004, message: "resource not found" };
        await term.release();
        this.terminals.delete(req.params.terminalId);
        return okResponse(req.id, {});
      }

      return null;
    } catch (err) {
      return errorResponse(req.id, err);
    }
  }
}
