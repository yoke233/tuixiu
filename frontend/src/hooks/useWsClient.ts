import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Artifact, Event } from "../types";

export type WsMessage = {
  type: string;
  run_id?: string;
  issue_id?: string;
  task_id?: string;
  step_id?: string;
  event?: Event;
  artifact?: Artifact;
};

function appendToken(url: string, token: string | null): string {
  const t = typeof token === "string" ? token.trim() : "";
  if (!t) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.get("token")) u.searchParams.set("token", t);
    return u.toString();
  } catch {
    return url;
  }
}

function getWsUrl(token: string | null): string {
  const base = import.meta.env.VITE_WS_URL as string | undefined;
  if (base && base.trim()) {
    return appendToken(`${base.replace(/\/+$/, "")}/ws/client`, token);
  }
  if (typeof window !== "undefined" && window.location) {
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsBase = `${wsProtocol}//${window.location.host}`;
    return appendToken(`${wsBase}/ws/client`, token);
  }
  return appendToken("ws://localhost:3000/ws/client", token);
}

export function useWsClient(onMessage: (msg: WsMessage) => void, opts?: { token?: string | null }) {
  const token = opts?.token ?? null;
  const url = useMemo(() => getWsUrl(token), [token]);
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
      ws.onclose = () => {
        if (disposed) return;
        if (socketRef.current === ws) socketRef.current = null;
        setStatus("closed");
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
