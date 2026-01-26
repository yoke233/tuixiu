import { useEffect, useMemo, useRef, type ReactNode } from "react";

import type { Event } from "../types";

type ConsoleRole = "user" | "agent" | "system";
type ConsoleKind = "chunk" | "block";

type ToolCallInfo = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  cwd?: string;
  command?: string;
  exitCode?: number;
  output?: string;
  stderr?: string;
};

type ConsoleItem = {
  id: string;
  role: ConsoleRole;
  kind: ConsoleKind;
  text: string;
  timestamp: string;
  toolCallId?: string;
  toolCallInfo?: ToolCallInfo;
  detailsTitle?: string;
  chunkType?: "agent_message" | "agent_thought" | "user_message";
  plan?: {
    entries: Array<{
      status: string;
      content: string;
      priority?: string;
    }>;
  };
};

function ConsoleDetailsBlock(props: {
  className: string;
  bordered?: boolean;
  defaultOpen?: boolean;
  summary: ReactNode;
  body: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <details
      className={`${props.className}${props.bordered ? " consoleDetailsBorder" : ""}`}
      open={props.defaultOpen}
    >
      <summary className="detailsSummary">
        <span className="toolSummaryRow">
          {props.summary}
          <span className="detailsCaret">▸</span>
        </span>
      </summary>
      <div className={props.bodyClassName ?? "pre"}>{props.body}</div>
    </details>
  );
}

function extractToolCallInfo(update: any): ToolCallInfo | null {
  if (!update || typeof update !== "object") return null;

  const title = typeof update.title === "string" ? update.title : "";
  const kind = typeof update.kind === "string" ? update.kind : "";
  const status = typeof update.status === "string" ? update.status : "";

  const rawInput = update.rawInput as any;
  const rawOutput = update.rawOutput as any;
  const raw = rawInput ?? rawOutput;

  const toolCallId =
    typeof update.toolCallId === "string"
      ? update.toolCallId
      : typeof raw?.call_id === "string"
        ? raw.call_id
        : "";
  const cwd = typeof raw?.cwd === "string" ? raw.cwd : "";

  const command = raw?.command;
  let cmdText = "";
  if (Array.isArray(command)) {
    cmdText = command.filter((x: unknown) => typeof x === "string").join(" ");
  } else if (typeof command === "string") {
    cmdText = command;
  } else if (Array.isArray(raw?.parsed_cmd) && raw.parsed_cmd.length) {
    const first = raw.parsed_cmd[0] as any;
    if (first && typeof first === "object" && typeof first.cmd === "string") {
      cmdText = first.cmd;
    }
  }

  const exitCode =
    typeof rawOutput?.exit_code === "number"
      ? rawOutput.exit_code
      : typeof rawOutput?.exitCode === "number"
        ? rawOutput.exitCode
        : undefined;

  const stdout = typeof rawOutput?.stdout === "string" ? rawOutput.stdout : "";
  const stderr = typeof rawOutput?.stderr === "string" ? rawOutput.stderr : "";
  const formattedOutput =
    typeof rawOutput?.formatted_output === "string"
      ? rawOutput.formatted_output
      : typeof rawOutput?.aggregated_output === "string"
        ? rawOutput.aggregated_output
        : "";

  const output = formattedOutput || stdout;

  return {
    toolCallId,
    title: title || undefined,
    kind: kind || undefined,
    status: status || undefined,
    cwd: cwd || undefined,
    command: cmdText || undefined,
    exitCode,
    output: output || undefined,
    stderr: stderr || undefined
  };
}

function formatToolCallInfo(info: ToolCallInfo | null): string | null {
  if (!info) return null;
  const metaParts: string[] = [];
  if (info.kind) metaParts.push(info.kind);
  if (info.status) metaParts.push(info.status);

  const head = `（工具调用${metaParts.length ? `: ${metaParts.join(" / ")}` : ""}${info.title ? ` - ${info.title}` : ""}）`;
  const lines = [head];
  if (info.toolCallId) lines.push(`toolCallId: ${info.toolCallId}`);
  if (info.cwd) lines.push(`cwd: ${info.cwd}`);
  if (info.command) lines.push(`command: ${info.command}`);
  if (typeof info.exitCode === "number") lines.push(`exitCode: ${info.exitCode}`);
  if (info.output) lines.push(`output:\n${info.output}`);
  if (info.stderr && info.stderr.trim()) lines.push(`stderr:\n${info.stderr}`);
  return lines.join("\n");
}

function getToolTitle(info: ToolCallInfo): string {
  return info.title || info.command || info.toolCallId || "tool_call";
}

function kindToBadgeClass(kind: string): string {
  if (kind === "delete") return "badge red";
  if (kind === "edit") return "badge orange";
  if (kind === "execute") return "badge blue";
  if (kind === "read") return "badge purple";
  if (kind === "search") return "badge blue";
  if (kind === "fetch") return "badge blue";
  if (kind === "move") return "badge blue";
  if (kind === "think") return "badge gray";
  return "badge gray";
}

function statusToBadgeClass(status: string): string {
  if (status === "pending") return "badge gray";
  if (status === "in_progress") return "badge orange";
  if (status === "completed") return "badge green";
  if (status === "failed") return "badge red";
  if (status === "cancelled") return "badge gray";
  return "badge gray";
}

function priorityToBadgeClass(priority: string): string {
  if (priority === "high") return "badge red";
  if (priority === "medium") return "badge orange";
  if (priority === "low") return "badge gray";
  return "badge gray";
}

function exitToBadgeClass(exitCode: number): string {
  return exitCode === 0 ? "badge green" : "badge red";
}

function mergeToolCallInfo(a: ToolCallInfo, b: ToolCallInfo): ToolCallInfo {
  const pick = <T,>(left: T | undefined, right: T | undefined) => (right ?? left);
  return {
    toolCallId: a.toolCallId,
    title: pick(a.title, b.title),
    kind: pick(a.kind, b.kind),
    status: pick(a.status, b.status),
    cwd: pick(a.cwd, b.cwd),
    command: pick(a.command, b.command),
    exitCode: pick(a.exitCode, b.exitCode),
    output: pick(a.output, b.output),
    stderr: pick(a.stderr, b.stderr)
  };
}

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
      (cmd as any).input && typeof (cmd as any).input === "object" && typeof (cmd as any).input.hint === "string"
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

function stripSideSpaces(s: string): string {
  return s.trim();
}

function extractPlan(update: any): ConsoleItem["plan"] | null {
  const entries = update?.entries;
  if (!Array.isArray(entries) || !entries.length) return null;
  const out: Array<{ status: string; content: string; priority?: string }> = [];
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const status = typeof (e as any).status === "string" ? String((e as any).status).trim() : "";
    const content = typeof (e as any).content === "string" ? String((e as any).content).trim() : "";
    const priority = typeof (e as any).priority === "string" ? String((e as any).priority).trim() : "";
    if (!status || !content) continue;
    out.push({ status, content, priority: priority || undefined });
  }
  if (!out.length) return null;
  return { entries: out };
}

function eventToConsoleItem(e: Event): ConsoleItem {
  if (e.source === "user") {
    const text = (e.payload as any)?.text;
    return {
      id: e.id,
      role: "user",
      kind: "block",
      text: typeof text === "string" ? text : JSON.stringify(e.payload, null, 2),
      timestamp: e.timestamp
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
        timestamp: e.timestamp
      };
    }

    if (payload?.type === "prompt_result") {
      return {
        id: e.id,
        role: "system",
        kind: "block",
        text: "",
        timestamp: e.timestamp
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
          chunkType: sessionUpdate === "agent_thought_chunk" ? "agent_thought" : "agent_message"
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
          chunkType: "user_message"
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
          plan: plan ?? undefined
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
          toolCallInfo: toolCallInfo.toolCallId ? toolCallInfo : undefined
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
          toolCallInfo: toolCallInfo.toolCallId ? toolCallInfo : undefined
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
          detailsTitle: formatted?.title
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
        timestamp: e.timestamp
      };
    }

    return {
      id: e.id,
      role: "system",
      kind: "block",
      text: JSON.stringify(payload ?? null, null, 2),
      timestamp: e.timestamp
    };
  }

  return {
    id: e.id,
    role: "system",
    kind: "block",
    text: `${e.type}: ${e.payload ? JSON.stringify(e.payload, null, 2) : ""}`.trim(),
    timestamp: e.timestamp
  };
}

export function RunConsole(props: { events: Event[] }) {
  const items = useMemo(() => {
    const ordered = [...props.events];
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
      if (
        last &&
        last.kind === "chunk" &&
        item.kind === "chunk" &&
        last.role === item.role &&
        last.chunkType === item.chunkType
      ) {
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
  }, [props.events]);

  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    lastScrollTopRef.current = el.scrollTop;

    const updateStickiness = () => {
      const currentScrollTop = el.scrollTop;
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = currentScrollTop;

      if (currentScrollTop < previousScrollTop) {
        stickToBottomRef.current = false;
        return;
      }

      const distance = el.scrollHeight - currentScrollTop - el.clientHeight;
      stickToBottomRef.current = distance <= 1;
    };

    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => el.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!stickToBottomRef.current) return;

    if (typeof (el as any).scrollTo === "function") {
      (el as any).scrollTo({ top: el.scrollHeight });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  if (!items.length) return <div className="muted">暂无输出（无日志）</div>;

  return (
    <div ref={ref} className="console" role="log" aria-label="运行输出">
      {items.map((item) => {
        if (item.role === "system" && item.plan) {
          const entries = item.plan.entries;
          const counts = entries.reduce(
            (acc, e) => {
              if (e.status === "completed") acc.completed += 1;
              else if (e.status === "in_progress") acc.in_progress += 1;
              else acc.pending += 1;
              return acc;
            },
            { completed: 0, in_progress: 0, pending: 0 }
          );
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              defaultOpen
              summary={
                <>
                  <span className="badge gray">PLAN</span>
                  <span className="toolSummaryTitle">
                    计划（{counts.completed}/{entries.length}）
                  </span>
                  {counts.in_progress ? <span className="badge orange">in_progress {counts.in_progress}</span> : null}
                  {counts.pending ? <span className="badge gray">pending {counts.pending}</span> : null}
                </>
              }
              bodyClassName="planBody"
              body={
                <div className="planList">
                  {entries.map((e, idx) => (
                    <div key={`${idx}-${e.status}-${e.content}`} className="planItem">
                      <span className={statusToBadgeClass(e.status)}>{e.status}</span>
                      {e.priority ? <span className={priorityToBadgeClass(e.priority)}>{e.priority}</span> : null}
                      <span className="planContent">{e.content}</span>
                    </div>
                  ))}
                </div>
              }
            />
          );
        }
        if (item.role === "user" && item.kind === "chunk" && item.chunkType === "user_message") {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">New Session</span>
                  <span className="toolSummaryTitle"></span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "agent" && item.kind === "chunk" && item.chunkType === "agent_thought") {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              bordered
              summary={
                <>
                  <span className="badge gray">THINK</span>
                  <span className="toolSummaryTitle">思考</span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "system" && item.detailsTitle) {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">INFO</span>
                  <span className="toolSummaryTitle">{item.detailsTitle}</span>
                </>
              }
              body={item.text}
            />
          );
        }
        if (item.role === "system" && item.toolCallInfo) {
          return (
            <ConsoleDetailsBlock
              key={item.id}
              className={`consoleItem ${item.role}`}
              summary={
                <>
                  <span className="badge gray">TOOL</span>
                  {item.toolCallInfo.kind ? (
                    <span className={kindToBadgeClass(item.toolCallInfo.kind)}>{item.toolCallInfo.kind}</span>
                  ) : null}
                  {item.toolCallInfo.status ? (
                    <span className={statusToBadgeClass(item.toolCallInfo.status)}>{item.toolCallInfo.status}</span>
                  ) : null}
                  {typeof item.toolCallInfo.exitCode === "number" ? (
                    <span className={exitToBadgeClass(item.toolCallInfo.exitCode)}>
                      exit {item.toolCallInfo.exitCode}
                    </span>
                  ) : null}
                  <span className="toolSummaryTitle">{getToolTitle(item.toolCallInfo)}</span>
                </>
              }
              body={item.text}
            />
          );
        }
        return (
          <div key={item.id} className={`consoleItem ${item.role}`}>
            {item.role === "user" ? `你: ${item.text}` : item.text}
          </div>
        );
      })}
    </div>
  );
}
