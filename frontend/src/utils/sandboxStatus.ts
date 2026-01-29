import type { Event } from "../types";

export type SandboxInstanceStatus = {
  status: string;
  runtime: string | null;
  provider: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  instanceName: string | null;
};

function safeTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseSandboxInstanceStatusText(text: string): SandboxInstanceStatus | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  if (!trimmed.includes('"sandbox_instance_status"')) return null;
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      status?: string;
      runtime?: string | null;
      provider?: string | null;
      last_error?: string | null;
      last_seen_at?: string | null;
      instance_name?: string | null;
    };
    if (!parsed || parsed.type !== "sandbox_instance_status") return null;
    const status = safeTrimmedString(parsed.status) ?? "unknown";
    return {
      status,
      runtime: safeTrimmedString(parsed.runtime) ?? null,
      provider: safeTrimmedString(parsed.provider) ?? null,
      lastError: safeTrimmedString(parsed.last_error) ?? null,
      lastSeenAt: safeTrimmedString(parsed.last_seen_at) ?? null,
      instanceName: safeTrimmedString(parsed.instance_name) ?? null,
    };
  } catch {
    return null;
  }
}

function extractSandboxTextFromEvent(event: Event): string | null {
  const payload = event.payload as any;
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.text === "string") return payload.text;
  if (payload.type === "text" && typeof payload.text === "string") return payload.text;
  if (payload.update?.content && typeof payload.update.content.text === "string") {
    return payload.update.content.text;
  }
  return null;
}

export function findLatestSandboxInstanceStatus(events: Event[]): SandboxInstanceStatus | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const text = extractSandboxTextFromEvent(events[i]);
    if (!text) continue;
    const parsed = parseSandboxInstanceStatusText(text);
    if (parsed) return parsed;
  }
  return null;
}
