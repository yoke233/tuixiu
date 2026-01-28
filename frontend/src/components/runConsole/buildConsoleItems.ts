import type { Event } from "../../types";

import { eventToConsoleItem } from "./eventToConsoleItem";
import { formatToolCallInfo, mergeToolCallInfo } from "./toolCallInfo";
import type { ConsoleItem } from "./types";

function stripSideSpaces(s: string): string {
  return s.trim();
}

export function buildConsoleItems(events: Event[]): ConsoleItem[] {
  const ordered = [...events];
  // 后端按 timestamp desc 返回 events，这里只做 reverse，避免排序打散 chunk。
  if (ordered.length >= 2) {
    const first = String(ordered[0]?.timestamp ?? "");
    const last = String(ordered[ordered.length - 1]?.timestamp ?? "");
    if (first > last) ordered.reverse();
  }

  const out: ConsoleItem[] = [];
  for (const e of ordered) {
    const item = eventToConsoleItem(e);
    if (!item.text && !item.plan) continue;

    const last = out[out.length - 1];
    if (last && last.kind === "chunk" && item.kind === "chunk" && last.role === item.role && last.chunkType === item.chunkType) {
      last.text += item.text;
      last.timestamp = item.timestamp;
      continue;
    }
    if (
      last &&
      last.kind === "block" &&
      item.kind === "block" &&
      last.role === "system" &&
      item.role === "system" &&
      last.toolCallId &&
      item.toolCallId &&
      last.toolCallId === item.toolCallId &&
      last.toolCallInfo &&
      item.toolCallInfo
    ) {
      const merged = mergeToolCallInfo(last.toolCallInfo, item.toolCallInfo);
      last.toolCallInfo = merged;
      last.text = formatToolCallInfo(merged) ?? last.text;
      last.timestamp = item.timestamp;
      continue;
    }
    out.push(item);
  }

  const finalOut: ConsoleItem[] = [];
  for (const item of out) {
    if (item.kind === "chunk" && (item.chunkType === "agent_message" || item.chunkType === "agent_thought")) {
      const text = stripSideSpaces(item.text);
      if (!text) continue;
      item.text = text;
    }
    finalOut.push(item);
  }

  return finalOut;
}

