import type { ToolCallInfo } from "@/components/runConsole/types";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

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

export function kindToTone(kind: string): BadgeTone {
  if (kind === "delete") return "danger";
  if (kind === "edit") return "warning";
  if (kind === "execute") return "info";
  if (kind === "read") return "neutral";
  if (kind === "search") return "info";
  if (kind === "fetch") return "info";
  if (kind === "move") return "info";
  if (kind === "think") return "neutral";
  return "neutral";
}

export function statusToTone(status: string): BadgeTone {
  if (status === "pending") return "neutral";
  if (status === "in_progress") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "cancelled") return "neutral";
  return "neutral";
}

export function priorityToTone(priority: string): BadgeTone {
  if (priority === "high") return "danger";
  if (priority === "medium") return "warning";
  if (priority === "low") return "neutral";
  return "neutral";
}

export function exitToTone(exitCode: number): BadgeTone {
  return exitCode === 0 ? "success" : "danger";
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
