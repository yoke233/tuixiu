import { useEffect, useMemo, useState } from "react";

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

  useEffect(() => {
    const ws = new WebSocket(url);
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
    };
  }, [onMessage, url]);

  return { status, url };
}
