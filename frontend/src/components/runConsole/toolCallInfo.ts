import type { ToolCallInfo } from "./types";

export function extractToolCallInfo(update: any): ToolCallInfo | null {
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
    stderr: stderr || undefined,
  };
}

export function formatToolCallInfo(info: ToolCallInfo | null): string | null {
  if (!info) return null;
  const metaParts: string[] = [];
  if (info.kind) metaParts.push(info.kind);
  if (info.status) metaParts.push(info.status);

  const head = `[${metaParts.length ? `${metaParts.join(" / ")}` : ""}${info.title ? ` - ${info.title}` : ""}]`;
  const lines = [head];
  if (info.toolCallId) lines.push(`toolCallId: ${info.toolCallId}`);
  if (info.cwd) lines.push(`cwd: ${info.cwd}`);
  if (info.command) lines.push(`command: ${info.command}`);
  if (typeof info.exitCode === "number") lines.push(`exitCode: ${info.exitCode}`);
  if (info.output) lines.push(`output:\n${info.output}`);
  if (info.stderr && info.stderr.trim()) lines.push(`stderr:\n${info.stderr}`);
  return lines.join("\n");
}

// 最多50字
export function getToolTitle(info: ToolCallInfo): string {
  return (info.title || info.command || info.toolCallId || "tool_call").substring(0, 110);
}

export function kindToBadgeClass(kind: string): string {
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

export function statusToBadgeClass(status: string): string {
  if (status === "pending") return "badge gray";
  if (status === "in_progress") return "badge orange";
  if (status === "completed") return "badge green";
  if (status === "failed") return "badge red";
  if (status === "cancelled") return "badge gray";
  return "badge gray";
}

export function priorityToBadgeClass(priority: string): string {
  if (priority === "high") return "badge red";
  if (priority === "medium") return "badge orange";
  if (priority === "low") return "badge gray";
  return "badge gray";
}

export function exitToBadgeClass(exitCode: number): string {
  return exitCode === 0 ? "badge green" : "badge red";
}

export function mergeToolCallInfo(a: ToolCallInfo, b: ToolCallInfo): ToolCallInfo {
  const pick = <T>(left: T | undefined, right: T | undefined) => right ?? left;
  return {
    toolCallId: a.toolCallId,
    title: pick(a.title, b.title),
    kind: pick(a.kind, b.kind),
    status: pick(a.status, b.status),
    cwd: pick(a.cwd, b.cwd),
    command: pick(a.command, b.command),
    exitCode: pick(a.exitCode, b.exitCode),
    output: pick(a.output, b.output),
    stderr: pick(a.stderr, b.stderr),
  };
}
