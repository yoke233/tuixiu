import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiUrl } from "@/api/client";
import type { Artifact, Event } from "@/types";

export type WsMessage = {
  type: string;
  run_id?: string;
  issue_id?: string;
  task_id?: string;
  step_id?: string;
  event?: Event;
  artifact?: Artifact;
  request_id?: string;
  ok?: boolean;
  error?: { code: string; message: string; details?: string };
};

function getWsUrl(): string {
  const base = import.meta.env.VITE_WS_URL as string | undefined;
  if (base && base.trim()) {
    return `${base.replace(/\/+$/, "")}/ws/client`;
  }
  if (typeof window !== "undefined" && window.location) {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsBase = `${wsProtocol}//${window.location.host}`;
    return `${wsBase}/ws/client`;
  }
  return "ws://localhost:3000/ws/client";
}

export function useWsClient(onMessage: (msg: WsMessage) => void) {
  const url = useMemo(() => getWsUrl(), []);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let disposed = false;

    const clearReconnectTimer = () => {
      const id = reconnectTimerRef.current;
      if (id == null) return;
      reconnectTimerRef.current = null;
      try {
        clearTimeout(id);
      } catch {
        // ignore
      }
    };

    const scheduleReconnect = () => {
      clearReconnectTimer();
      if (disposed) return;
      const attempt = reconnectAttemptRef.current;
      const baseMs = 500;
      const maxMs = 10_000;
      const delayMs = Math.min(maxMs, baseMs * 2 ** Math.min(5, attempt));
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (disposed) return;
        connect();
      }, delayMs) as unknown as number;
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");

      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        reconnectAttemptRef.current = 0;
        setStatus("open");
      };
      ws.onclose = (evt) => {
        if (disposed) return;
        if (socketRef.current === ws) socketRef.current = null;
        setStatus("closed");
        if (evt.code === 1008) {
          void fetch(apiUrl("/auth/refresh"), { method: "POST", credentials: "include" })
            .catch(() => {})
            .finally(() => {
              scheduleReconnect();
            });
          return;
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose 会负责触发重连；这里不做额外处理，避免重复 schedule
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data)) as WsMessage;
          if (msg && typeof msg === "object" && typeof msg.type === "string") {
            onMessageRef.current(msg);
          }
        } catch {
          // ignore
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      const ws = socketRef.current;
      socketRef.current = null;
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, [url]);

  const sendJson = useCallback((payload: unknown): boolean => {
    const ws = socketRef.current;
    if (!ws) return false;
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { status, url, sendJson };
}
