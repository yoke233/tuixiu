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

  useEffect(() => {
    const ws = new WebSocket(url);
    socketRef.current = ws;
    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as WsMessage;
        if (msg && typeof msg === "object" && typeof msg.type === "string") {
          onMessage(msg);
        }
      } catch {
        // ignore
      }
    };

    return () => {
      ws.close();
      if (socketRef.current === ws) socketRef.current = null;
    };
  }, [onMessage, url]);

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
