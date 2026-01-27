type EventLike = { timestamp?: string; source?: string; payload?: unknown };

function safeTimestamp(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extractAgentTextFromEvents(events: EventLike[]): string {
  const ordered = [...events].sort((a, b) => safeTimestamp(a.timestamp).localeCompare(safeTimestamp(b.timestamp)));
  let text = "";
  for (const e of ordered) {
    if (String((e as any)?.source ?? "") !== "acp") continue;
    const payload = (e as any)?.payload as any;
    if (payload?.type !== "session_update") continue;
    const upd = payload.update as any;
    if (upd?.sessionUpdate !== "agent_message_chunk") continue;
    if (upd?.content?.type !== "text") continue;
    const t = upd?.content?.text;
    if (typeof t === "string") text += t;
  }
  return text;
}

export function extractTaggedCodeBlock(text: string, tag: string): string {
  const re = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)\\n```", "m");
  const m = text.match(re);
  return m ? String(m[1] ?? "").trim() : "";
}

