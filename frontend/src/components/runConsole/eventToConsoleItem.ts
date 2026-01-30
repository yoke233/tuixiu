import type { Event } from "../../types";

import { extractToolCallInfo, formatToolCallInfo } from "./toolCallInfo";
import type { ConsoleItem, PermissionOption } from "./types";
import { summarizeContentBlocks, tryParseContentBlocks } from "../../acp/contentBlocks";

function extractTextFromUpdateContent(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (typeof content !== "object") return null;

  const rec = content as Record<string, unknown>;
  if (typeof rec.text === "string") return rec.text;

  if (Array.isArray(rec.content)) {
    const parts: string[] = [];
    for (const item of rec.content) {
      if (!item || typeof item !== "object") continue;
      const ir = item as Record<string, unknown>;
      const inner = ir.content;
      if (inner && typeof inner === "object" && typeof (inner as any).text === "string") {
        parts.push(String((inner as any).text));
        continue;
      }
      if (typeof ir.text === "string") {
        parts.push(ir.text);
      }
    }
    return parts.length ? parts.join("") : null;
  }

  return null;
}

function formatConfigOptionsUpdate(update: any): { title: string; body: string } | null {
  const list = update?.configOptions;
  if (!Array.isArray(list) || !list.length) return null;

  const lines: string[] = [];

  for (const opt of list) {
    if (!opt || typeof opt !== "object") continue;

    const id = typeof (opt as any).id === "string" ? String((opt as any).id) : "";
    if (!id) continue;

    const name = typeof (opt as any).name === "string" ? String((opt as any).name).trim() : "";
    const type = typeof (opt as any).type === "string" ? String((opt as any).type).trim() : "";
    const category =
      typeof (opt as any).category === "string" ? String((opt as any).category).trim() : "";
    const description =
      typeof (opt as any).description === "string" ? String((opt as any).description).trim() : "";

    const currentValue = (opt as any).currentValue;
    const currentValueStr =
      currentValue === undefined ? "" : `current=${JSON.stringify(currentValue)}`;

    const headParts = [
      `${id}${name ? ` (${name})` : ""}`,
      type ? `type=${type}` : "",
      category ? `category=${category}` : "",
      currentValueStr,
    ].filter(Boolean);

    lines.push(`- ${headParts.join(" | ")}`);

    if (description) lines.push(`  ${description}`);

    const options = (opt as any).options;
    if (Array.isArray(options) && options.length) {
      for (const o of options) {
        if (!o || typeof o !== "object") continue;
        const oname = typeof (o as any).name === "string" ? String((o as any).name).trim() : "";
        const oval = (o as any).value;
        const odesc =
          typeof (o as any).description === "string" ? String((o as any).description).trim() : "";
        const parts = [
          oname || "",
          oval === undefined ? "" : `value=${JSON.stringify(oval)}`,
          odesc || "",
        ].filter(Boolean);
        if (parts.length) lines.push(`  - ${parts.join(" | ")}`);
      }
    }
  }

  if (!lines.length) return null;
  return { title: `配置选项（${list.length}）`, body: lines.join("\n") };
}


function formatAvailableCommandsUpdate(update: any): { title: string; body: string } | null {
  const list = update?.availableCommands;
  if (!Array.isArray(list) || !list.length) return null;

  const lines: string[] = [];
  for (const cmd of list) {
    if (!cmd || typeof cmd !== "object") continue;
    const name = typeof (cmd as any).name === "string" ? String((cmd as any).name) : "";
    if (!name) continue;

    const description =
      typeof (cmd as any).description === "string" ? String((cmd as any).description).trim() : "";
    const hint =
      (cmd as any).input &&
      typeof (cmd as any).input === "object" &&
      typeof (cmd as any).input.hint === "string"
        ? String((cmd as any).input.hint).trim()
        : "";

    const parts: string[] = [name];
    if (description) parts.push(description);
    if (hint) parts.push(`hint: ${hint}`);
    lines.push(`- ${parts.join(" | ")}`);
  }

  if (!lines.length) return null;
  return { title: `可用命令（${lines.length}）`, body: lines.join("\n") };
}

function extractPlan(update: any): ConsoleItem["plan"] | null {
  const entries = update?.entries;
  if (!Array.isArray(entries) || !entries.length) return null;
  const out: Array<{ status: string; content: string; priority?: string }> = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const status = typeof (e as any).status === "string" ? String((e as any).status).trim() : "";
    const content = typeof (e as any).content === "string" ? String((e as any).content).trim() : "";
    const priority =
      typeof (e as any).priority === "string" ? String((e as any).priority).trim() : "";
    if (!status || !content) continue;
    out.push({ status, content, priority: priority || undefined });
  }
  if (!out.length) return null;
  return { entries: out };
}

export function eventToConsoleItem(e: Event): ConsoleItem {
  if (e.source === "user") {
    const payload = e.payload as any;
    const blocks = tryParseContentBlocks(payload?.prompt);
    const textFromPrompt = blocks ? summarizeContentBlocks(blocks, { maxChars: 4000 }) : null;
    const textFromLegacy = typeof payload?.text === "string" ? payload.text : null;
    const text = textFromPrompt ?? textFromLegacy ?? JSON.stringify(payload ?? null, null, 2);
    return {
      id: e.id,
      role: "user",
      kind: "block",
      text,
      timestamp: e.timestamp,
    };
  }

  if (e.source === "acp" && e.type === "acp.update.received") {
    const payload = e.payload as any;

    if (payload?.type === "text" && typeof payload.text === "string") {
      return {
        id: e.id,
        role: "system",
        kind: "block",
        text: payload.text,
        timestamp: e.timestamp,
      };
    }

    if (payload?.type === "permission_request") {
      const requestIdRaw = payload?.request_id;
      const requestId = requestIdRaw == null ? "" : String(requestIdRaw);
      const sessionId = typeof payload?.session_id === "string" ? payload.session_id : "";
      const optionsRaw = Array.isArray(payload?.options) ? payload.options : [];
      const options = optionsRaw
        .filter((o: any) => o && typeof o === "object" && typeof o.optionId === "string")
        .map(
          (o: any) =>
            ({
              optionId: String(o.optionId),
              name: typeof o.name === "string" ? o.name : undefined,
              kind: typeof o.kind === "string" ? o.kind : undefined,
            }) satisfies PermissionOption,
        );

      return {
        id: e.id,
        role: "system",
        kind: "block",
        text: "",
        timestamp: e.timestamp,
        permissionRequest: {
          requestId,
          sessionId,
          promptId: typeof payload?.prompt_id === "string" ? String(payload.prompt_id) : null,
          toolCall: payload?.tool_call,
          options,
        },
      };
    }

    if (payload?.type === "init_step") {
      const stage = typeof payload.stage === "string" ? payload.stage.trim() : "";
      const status = typeof payload.status === "string" ? payload.status.trim() : "progress";
      const message = typeof payload.message === "string" ? payload.message.trim() : "";
      const parts = [stage, status, message].filter(Boolean);
      return {
        id: e.id,
        role: "system",
        kind: "block",
        text: parts.join(" "),
        timestamp: e.timestamp,
        initStep: {
          stage: stage || "init",
          status: status || "progress",
          message: message || undefined,
        },
      };
    }

    if (payload?.type === "prompt_result") {
      return {
        id: e.id,
        role: "system",
        kind: "block",
        text: "",
        timestamp: e.timestamp,
      };
    }

    if (payload?.type === "session_update" && payload.update) {
      const update = payload.update as any;
      const sessionUpdate = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

      if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
        const chunkText = update?.content?.text;
        return {
          id: e.id,
          role: "agent",
          kind: "chunk",
          text: typeof chunkText === "string" ? chunkText : "",
          timestamp: e.timestamp,
          chunkType: sessionUpdate === "agent_thought_chunk" ? "agent_thought" : "agent_message",
        };
      }

      if (sessionUpdate === "user_message_chunk") {
        const chunkText = update?.content?.text;
        return {
          id: e.id,
          role: "user",
          kind: "chunk",
          text: typeof chunkText === "string" ? chunkText : "",
          timestamp: e.timestamp,
          chunkType: "user_message",
        };
      }

      if (sessionUpdate === "plan") {
        const plan = extractPlan(update);
        return {
          id: e.id,
          role: "system",
          kind: "block",
          text: "",
          timestamp: e.timestamp,
          plan: plan ?? undefined,
        };
      }

      if (sessionUpdate === "tool_call") {
        const toolCallInfo = extractToolCallInfo(update) ?? { toolCallId: "" };
        const text = formatToolCallInfo(toolCallInfo) ?? JSON.stringify(update, null, 2);
        return {
          id: e.id,
          role: "system",
          kind: "block",
          text,
          timestamp: e.timestamp,
          toolCallId: toolCallInfo.toolCallId || undefined,
          toolCallInfo: toolCallInfo.toolCallId ? toolCallInfo : undefined,
        };
      }

      if (sessionUpdate === "tool_call_update") {
        const toolCallInfo = extractToolCallInfo(update) ?? { toolCallId: "" };
        const text = formatToolCallInfo(toolCallInfo) ?? JSON.stringify(update, null, 2);
        return {
          id: e.id,
          role: "system",
          kind: "block",
          text,
          timestamp: e.timestamp,
          toolCallId: toolCallInfo.toolCallId || undefined,
          toolCallInfo: toolCallInfo.toolCallId ? toolCallInfo : undefined,
        };
      }

      if (sessionUpdate === "available_commands_update") {
        const formatted = formatAvailableCommandsUpdate(update);
        const text =
          formatted?.body ??
          extractTextFromUpdateContent(update?.content) ??
          JSON.stringify(update, null, 2);
        return {
          id: e.id,
          role: "system",
          kind: "block",
          text,
          timestamp: e.timestamp,
          detailsTitle: formatted?.title,
        };
      }

      if (sessionUpdate === "config_option_update") {
        const formatted = formatConfigOptionsUpdate(update);
        const text = "";
          // formatted?.body ??
          // extractTextFromUpdateContent(update?.content) ??
          // JSON.stringify(update, null, 2);
        return {
          id: e.id,
          role: "system",
          kind: "block",
          text,
          timestamp: e.timestamp,
          detailsTitle: formatted?.title,
        };
      }

      const text =
        extractTextFromUpdateContent(update?.content) ??
        extractTextFromUpdateContent(update) ??
        JSON.stringify(update, null, 2);

      return {
        id: e.id,
        role: "system",
        kind: "block",
        text,
        timestamp: e.timestamp,
      };
    }

    return {
      id: e.id,
      role: "system",
      kind: "block",
      text: JSON.stringify(payload ?? null, null, 2),
      timestamp: e.timestamp,
    };
  }

  return {
    id: e.id,
    role: "system",
    kind: "block",
    text: `${e.type}: ${e.payload ? JSON.stringify(e.payload, null, 2) : ""}`.trim(),
    timestamp: e.timestamp,
  };
}
