import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";

import type { JsonRpcRequest } from "../../acpClientFacade.js";
import type { ProcessHandle } from "../../sandbox/types.js";
import { isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse } from "../utils/jsonRpc.js";

type JsonRpcId = string | number;

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type InitResult = { ok: boolean; exitCode: number | null };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toRpcError(payload: unknown): Error & { code?: number; data?: unknown } {
  if (payload instanceof Error) return payload as any;
  if (payload && typeof payload === "object") {
    const code = (payload as any).code;
    const message = (payload as any).message;
    const data = (payload as any).data;
    const err = new Error(typeof message === "string" ? message : String(payload)) as any;
    if (typeof code === "number") err.code = code;
    if (data !== undefined) err.data = data;
    return err;
  }
  return new Error(String(payload)) as any;
}

export class AgentBridge {
  private readonly handle: ProcessHandle;
  private readonly stream: ReturnType<typeof acp.ndJsonStream>;
  private readonly reader: ReadableStreamDefaultReader<acp.AnyMessage>;

  private writeQueue: Promise<void> = Promise.resolve();
  private readonly pendingRpc = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (err: unknown) => void }
  >();
  private nextRpcId = 1;

  private closed = false;
  private readonly abort = new AbortController();

  private readonly initMarkerPrefix: string;
  private initPending = false;
  private initDeferred: Deferred<InitResult> | null = null;

  constructor(opts: {
    handle: ProcessHandle;
    init?: { pending: boolean; markerPrefix: string };
    redactLine?: (line: string) => string;
    onNotification?: (msg: { method: string; params?: unknown }) => void;
    onRequest?: (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
    onStderrLine?: (line: string, kind: "init" | "agent") => void;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
  }) {
    this.handle = opts.handle;
    this.stream = acp.ndJsonStream(this.handle.stdin, this.handle.stdout);
    this.reader = this.stream.readable.getReader();

    this.initMarkerPrefix = opts.init?.markerPrefix ?? "__ACP_PROXY_INIT_RESULT__:";
    this.initPending = opts.init?.pending ?? false;
    this.initDeferred = this.initPending ? createDeferred<InitResult>() : null;

    void this.readLoop(opts).catch(() => {});
    void this.stderrLoop(opts).catch(() => {});

    this.handle.onExit?.((info) => {
      if (this.closed) return;
      opts.onExit?.(info);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();

    for (const pending of this.pendingRpc.values()) {
      try {
        pending.reject(new Error("agent closed"));
      } catch {
        // ignore
      }
    }
    this.pendingRpc.clear();

    try {
      await this.reader.cancel();
    } catch {
      // ignore
    }
    try {
      this.reader.releaseLock();
    } catch {
      // ignore
    }

    try {
      await this.handle.close();
    } catch {
      // ignore
    }
  }

  private async writeToAgent(message: acp.AnyMessage): Promise<void> {
    if (this.closed) throw new Error("agent not connected");
    this.writeQueue = this.writeQueue
      .then(async () => {
        const writer = this.stream.writable.getWriter();
        try {
          await writer.write(message as any);
        } finally {
          writer.releaseLock();
        }
      })
      .catch(() => {});
    await this.writeQueue;
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    await this.writeToAgent({ jsonrpc: "2.0", method, params } as any);
  }

  async sendRpc<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const id = this.nextRpcId++;
    const timeoutMs =
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : 300_000;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
    });

    await this.writeToAgent({ jsonrpc: "2.0", id, method, params } as any);

    return (await Promise.race([
      promise,
      delay(timeoutMs, { signal: this.abort.signal }).then(() => {
        this.pendingRpc.delete(id);
        throw new Error(`rpc timeout after ${timeoutMs}ms: ${method}`);
      }),
    ])) as T;
  }

  async waitForInitResult(opts: { timeoutMs: number }): Promise<InitResult> {
    if (!this.initDeferred) return { ok: true, exitCode: null };
    const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));

    const raced = await Promise.race([
      this.initDeferred.promise,
      delay(timeoutMs, { signal: this.abort.signal }).then(() => ({ ok: false, exitCode: null })),
    ]);

    if (!raced.ok) {
      throw new Error(`init timeout after ${timeoutMs}ms`);
    }
    return raced;
  }

  private async readLoop(opts: {
    onNotification?: (msg: { method: string; params?: unknown }) => void;
    onRequest?: (req: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
  }): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (this.closed) break;
        if (!value) continue;

        if (isJsonRpcRequest(value)) {
          const res = await opts.onRequest?.(value as any);
          if (res) await this.writeToAgent(res as any);
          continue;
        }

        if (isJsonRpcResponse(value)) {
          const pending = this.pendingRpc.get(value.id);
          if (pending) {
            this.pendingRpc.delete(value.id);
            if (value.error) pending.reject(toRpcError(value.error));
            else pending.resolve((value as any).result);
          }
          continue;
        }

        if (isJsonRpcNotification(value)) {
          opts.onNotification?.({ method: value.method, params: value.params });
          continue;
        }
      }
    } catch {
      // ignore
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private async stderrLoop(opts: {
    redactLine?: (line: string) => string;
    onStderrLine?: (line: string, kind: "init" | "agent") => void;
  }): Promise<void> {
    const stderr = this.handle.stderr;
    if (!stderr) {
      if (this.initDeferred) this.initDeferred.reject(new Error("stderr not available"));
      return;
    }

    const redact = opts.redactLine ?? ((s: string) => s);
    const decoder = new TextDecoder();
    const reader = stderr.getReader();

    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.closed) break;
        if (!value) continue;

        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n/g);
        buf = parts.pop() ?? "";
        for (const rawLine of parts) {
          const line = redact(rawLine);
          if (!line.trim()) continue;
          await this.onStderrLine(line, opts);
        }
      }
    } catch (err) {
      this.initDeferred?.reject(err);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      const rest = redact(buf);
      if (rest.trim()) {
        await this.onStderrLine(rest, opts);
      }
    }
  }

  private async onStderrLine(
    line: string,
    opts: { onStderrLine?: (line: string, kind: "init" | "agent") => void },
  ): Promise<void> {
    if (!this.initPending && line.startsWith(this.initMarkerPrefix)) return;

    if (this.initPending) {
      if (line.startsWith(this.initMarkerPrefix)) {
        const payloadRaw = line.slice(this.initMarkerPrefix.length).trim();
        try {
          const parsed = JSON.parse(payloadRaw) as any;
          const ok = !!parsed?.ok;
          const exitCode = typeof parsed?.exitCode === "number" ? parsed.exitCode : null;
          this.initDeferred?.resolve({ ok, exitCode });
        } catch (err) {
          this.initDeferred?.reject(
            new Error(
              `init marker JSON parse failed: ${String(err)}; payload=${JSON.stringify(payloadRaw)}`,
            ),
          );
        } finally {
          this.initPending = false;
        }
        return;
      }

      opts.onStderrLine?.(line, "init");
      return;
    }

    opts.onStderrLine?.(line, "agent");
  }
}
