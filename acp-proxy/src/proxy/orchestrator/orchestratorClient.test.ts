import { setTimeout as delay } from "node:timers/promises";

import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import { OrchestratorClient } from "./orchestratorClient.js";

async function waitForWssListening(wss: WebSocketServer, timeoutMs: number): Promise<void> {
  try {
    const addr = wss.address();
    if (addr) return;
  } catch {
    // ignore
  }

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      wss.once("listening", () => resolve());
      wss.once("error", (err) => reject(err));
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`timeout waiting for WebSocketServer listening (${timeoutMs}ms)`);
    }),
  ]);
}

async function waitFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = get();
    if (v !== undefined) return v;
    await delay(10);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe("proxy/orchestrator/OrchestratorClient", () => {
  it("connects and can send register_agent onConnected", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const messages: any[] = [];
    const connected = new Promise<WebSocket>((resolve) => {
      wss.once("connection", (ws) => resolve(ws));
    });

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          // ignore
        }
      });
    });

    const ac = new AbortController();

    try {
      await waitForWssListening(wss, 10_000);
      const port = (wss.address() as any).port as number;
      const url = `ws://127.0.0.1:${port}`;

      const client = new OrchestratorClient({
        url,
        heartbeatSeconds: 60,
        retryDelayMs: 50,
        log: () => {},
      });

      const loopP = client.connectLoop({
        signal: ac.signal,
        onMessage: () => {},
        onConnected: () => {
          client.send({ type: "register_agent", agent: { id: "a1", name: "a1" } });
        },
      });

      await connected;
      const reg = await waitFor(
        () =>
          messages.find((m) => m && typeof m === "object" && (m as any).type === "register_agent"),
        5_000,
      );
      expect(reg.type).toBe("register_agent");
      expect(reg.agent.id).toBe("a1");

      ac.abort();
      client.close();
      await loopP;
    } finally {
      try {
        wss.close();
      } catch {
        // ignore
      }
    }
  });
});
