import type { Event } from "@/types";

export type AcpTransportStatus = {
  connected: boolean;
  at: string;
  instanceName: string | null;
  reason: string | null;
  code: number | null;
  signal: string | null;
};

function safeTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function findLatestAcpTransportStatus(events: Event[]): AcpTransportStatus | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.source !== "acp" || e.type !== "acp.update.received") continue;
    const payload = e.payload as any;
    if (!payload || typeof payload !== "object") continue;

    const type = typeof payload.type === "string" ? payload.type : "";
    if (type !== "transport_connected" && type !== "transport_disconnected") continue;

    const at = typeof payload.at === "string" && payload.at.trim() ? payload.at : e.timestamp;
    return {
      connected: type === "transport_connected",
      at,
      instanceName: safeTrimmedString(payload.instance_name),
      reason: safeTrimmedString(payload.reason),
      code: typeof payload.code === "number" && Number.isFinite(payload.code) ? payload.code : null,
      signal: safeTrimmedString(payload.signal),
    };
  }
  return null;
}

