import type { Event, Run } from "@/types";

export type SessionState = {
  sessionId: string;
  activity: string;
  inFlight: number;
  updatedAt: string;
  currentModeId: string | null;
  currentModelId: string | null;
  lastStopReason: string | null;
  note: string | null;
};

function readSessionStateFromRun(run: Run | null): SessionState | null {
  const meta = (run as any)?.metadata;
  const state = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as any).acpSessionState : null;
  if (!state || typeof state !== "object") return null;

  const sessionId = typeof (state as any).sessionId === "string" ? String((state as any).sessionId) : "";
  if (!sessionId) return null;

  const activity = typeof (state as any).activity === "string" ? String((state as any).activity) : "unknown";
  const inFlightRaw = (state as any).inFlight;
  const inFlight = typeof inFlightRaw === "number" && Number.isFinite(inFlightRaw) ? Math.max(0, inFlightRaw) : 0;
  const updatedAt = typeof (state as any).updatedAt === "string" ? String((state as any).updatedAt) : "";
  const currentModeId = typeof (state as any).currentModeId === "string" ? String((state as any).currentModeId) : null;
  const currentModelId = typeof (state as any).currentModelId === "string" ? String((state as any).currentModelId) : null;
  const lastStopReason = typeof (state as any).lastStopReason === "string" ? String((state as any).lastStopReason) : null;
  const note = typeof (state as any).note === "string" ? String((state as any).note) : null;

  return {
    sessionId,
    activity,
    inFlight,
    updatedAt,
    currentModeId,
    currentModelId,
    lastStopReason,
    note,
  };
}

export function readSessionState(events: Event[]): SessionState | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const payload = (events[i] as any)?.payload;
    if (!payload || typeof payload !== "object") continue;
    if ((payload as any).type !== "session_state") continue;

    const sessionId = typeof (payload as any).session_id === "string" ? String((payload as any).session_id) : "";
    if (!sessionId) continue;

    const activity = typeof (payload as any).activity === "string" ? String((payload as any).activity) : "unknown";
    const inFlightRaw = (payload as any).in_flight;
    const inFlight = typeof inFlightRaw === "number" && Number.isFinite(inFlightRaw) ? Math.max(0, inFlightRaw) : 0;
    const updatedAt = typeof (payload as any).updated_at === "string" ? String((payload as any).updated_at) : "";
    const currentModeId = typeof (payload as any).current_mode_id === "string" ? String((payload as any).current_mode_id) : null;
    const currentModelId = typeof (payload as any).current_model_id === "string" ? String((payload as any).current_model_id) : null;
    const lastStopReason = typeof (payload as any).last_stop_reason === "string" ? String((payload as any).last_stop_reason) : null;
    const note = typeof (payload as any).note === "string" ? String((payload as any).note) : null;

    return {
      sessionId,
      activity,
      inFlight,
      updatedAt,
      currentModeId,
      currentModelId,
      lastStopReason,
      note,
    };
  }
  return null;
}

export function readEffectiveSessionState(opts: { events: Event[]; run: Run | null }): SessionState | null {
  return readSessionState(opts.events) ?? readSessionStateFromRun(opts.run);
}
