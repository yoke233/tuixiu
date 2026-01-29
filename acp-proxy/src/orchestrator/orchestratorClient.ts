import { setTimeout as delay } from "node:timers/promises";

import WebSocket from "ws";

import type { IncomingMessage } from "../types.js";
import type { Logger } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";

type HeartbeatPayloadFn = () => unknown;

async function waitForWsOpen(ws: WebSocket, signal: AbortSignal | undefined): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => cleanup(resolve);
    const onError = (err: unknown) => cleanup(() => reject(err));
    const onAbort = () => cleanup(() => reject(new Error("aborted")));

    const cleanup = (next: () => void) => {
      try {
        ws.off("open", onOpen);
      } catch {
        // ignore
      }
      try {
        ws.off("error", onError as any);
      } catch {
        // ignore
      }
      try {
        signal?.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
      next();
    };

    ws.once("open", onOpen);
    ws.once("error", onError as any);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForWsClose(ws: WebSocket, signal: AbortSignal | undefined): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const onClose = () => cleanup(resolve);
    const onError = (err: unknown) => cleanup(() => reject(err));
    const onAbort = () => cleanup(resolve);

    const cleanup = (next: () => void) => {
      try {
        ws.off("close", onClose);
      } catch {
        // ignore
      }
      try {
        ws.off("error", onError as any);
      } catch {
        // ignore
      }
      try {
        signal?.removeEventListener("abort", onAbort);
      } catch {
        // ignore
      }
      next();
    };

    ws.once("close", onClose);
    ws.once("error", onError as any);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class OrchestratorClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly heartbeatSeconds: number;
  private readonly retryDelayMs: number;
  private readonly log: Logger;

  constructor(opts: { url: string; heartbeatSeconds: number; log: Logger; retryDelayMs?: number }) {
    this.url = opts.url;
    this.heartbeatSeconds = opts.heartbeatSeconds;
    this.retryDelayMs =
      typeof opts.retryDelayMs === "number" ? Math.max(0, opts.retryDelayMs) : 1000;
    this.log = opts.log;
  }

  send(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  async connectLoop(opts: {
    signal?: AbortSignal;
    onMessage: (msg: IncomingMessage) => void | Promise<void>;
    onConnected?: () => void | Promise<void>;
    onDisconnected?: () => void | Promise<void>;
    heartbeatPayload?: HeartbeatPayloadFn;
  }): Promise<void> {
    const signal = opts.signal;

    const heartbeatLoop = async (hbSignal: AbortSignal) => {
      const payloadFn = opts.heartbeatPayload;
      if (!payloadFn) return;
      for (;;) {
        if (hbSignal.aborted || signal?.aborted) return;
        await delay(this.heartbeatSeconds * 1000, { signal: hbSignal }).catch(() => {});
        if (hbSignal.aborted || signal?.aborted) return;
        try {
          this.send(payloadFn());
        } catch {
          // ignore
        }
      }
    };

    for (;;) {
      if (signal?.aborted) return;

      let ws: WebSocket | null = null;
      const hb = new AbortController();
      try {
        this.log("connecting", { url: this.url });
        ws = new WebSocket(this.url);
        this.ws = ws;

        ws.on("message", (data) => {
          try {
            const text = data.toString();
            const msg = JSON.parse(text) as IncomingMessage;
            if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;
            void Promise.resolve(opts.onMessage(msg)).catch((err) => {
              this.log("failed to handle ws message", { err: String(err) });
            });
          } catch (err) {
            this.log("failed to handle ws message", { err: String(err) });
          }
        });

        await waitForWsOpen(ws, signal);
        if (signal?.aborted) return;

        await opts.onConnected?.();
        void heartbeatLoop(hb.signal);

        await waitForWsClose(ws, signal);
        hb.abort();
        await opts.onDisconnected?.();
      } catch (err) {
        hb.abort();
        if (signal?.aborted) return;
        this.log("connection failed; retrying", { err: String(err) });
      } finally {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        if (this.ws === ws) this.ws = null;
      }

      if (signal?.aborted) return;
      await delay(this.retryDelayMs, { signal }).catch(() => {});
    }
  }
}
