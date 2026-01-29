import { summarizeAcpContentBlocks, tryParseAcpContentBlocks } from "../acp/acpContent.js";

type ContextEvent = { source?: string; type?: string; payload?: any; timestamp?: any };

function trimTail(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

export function buildContextFromRun(opts: {
  run: any;
  issue: any;
  events: ContextEvent[];
}): string {
  const issue = opts.issue ?? {};
  const run = opts.run ?? {};

  const parts: string[] = [];
  if (issue.title) parts.push(`任务标题: ${issue.title}`);
  if (issue.description) parts.push(`任务描述:\n${issue.description}`);

  const acceptance = Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria : [];
  if (acceptance.length) {
    parts.push(`验收标准:\n${acceptance.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  const constraints = Array.isArray(issue.constraints) ? issue.constraints : [];
  if (constraints.length) {
    parts.push(`约束条件:\n${constraints.map((x: unknown) => `- ${String(x)}`).join("\n")}`);
  }
  if (issue.testRequirements) parts.push(`测试要求:\n${issue.testRequirements}`);

  const branch =
    run.branchName || (run.artifacts ?? []).find((a: any) => a.type === "branch")?.content?.branch;
  if (typeof branch === "string" && branch) parts.push(`当前分支: ${branch}`);

  // 对话节选：仅保留用户消息 + agent_message_chunk + 系统文本（避免把巨大工具输出塞进 prompt）。
  const events = [...(opts.events ?? [])];
  events.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));

  const lines: string[] = [];
  let agentBuf = "";
  const flushAgent = () => {
    const text = agentBuf.trim();
    if (!text) {
      agentBuf = "";
      return;
    }
    lines.push(`Agent: ${text}`);
    agentBuf = "";
  };

  for (const e of events) {
    const source = String(e.source ?? "");
    const payload = e.payload as any;

    if (source === "user") {
      flushAgent();
      const t = payload?.text;
      if (typeof t === "string" && t.trim()) {
        lines.push(`User: ${t.trim()}`);
        continue;
      }

      const blocks = tryParseAcpContentBlocks(payload?.prompt);
      if (blocks?.length) {
        const summary = summarizeAcpContentBlocks(blocks, { maxChars: 1200 });
        if (summary.trim()) lines.push(`User: ${summary.trim()}`);
      }
      continue;
    }

    if (source === "acp" && payload?.type === "session_update") {
      const upd = payload.update as any;
      if (upd?.sessionUpdate === "agent_message_chunk" && upd?.content?.type === "text") {
        const t = upd.content.text;
        if (typeof t === "string" && t) {
          agentBuf += t;
          if (agentBuf.length > 1200 || t.includes("\n\n")) flushAgent();
        }
        continue;
      }

      // 其它 session_update 作为边界：先 flush，避免顺序混乱
      flushAgent();
      continue;
    }

    if (source === "acp" && payload?.type === "text") {
      flushAgent();
      const t = payload.text;
      if (typeof t === "string" && t.trim()) lines.push(`System: ${t.trim()}`);
      continue;
    }

    if (source === "acp" && payload?.type === "prompt_result") {
      flushAgent();
      continue;
    }
  }
  flushAgent();

  if (lines.length) {
    parts.push(`最近对话节选:\n${lines.slice(-40).join("\n")}`);
  }

  return trimTail(parts.join("\n\n"), 9000);
}

export function buildChatContextFromEvents(events: ContextEvent[]): string {
  const sorted = [...(events ?? [])];
  sorted.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));

  const lines: string[] = [];
  let agentBuf = "";
  const flushAgent = () => {
    const text = agentBuf.trim();
    if (!text) {
      agentBuf = "";
      return;
    }
    lines.push(`Agent: ${text}`);
    agentBuf = "";
  };

  for (const e of sorted) {
    const source = String(e.source ?? "");
    const payload = e.payload as any;

    if (source === "user") {
      flushAgent();
      const t = payload?.text;
      if (typeof t === "string" && t.trim()) {
        lines.push(`User: ${t.trim()}`);
        continue;
      }

      const blocks = tryParseAcpContentBlocks(payload?.prompt);
      if (blocks?.length) {
        const summary = summarizeAcpContentBlocks(blocks, { maxChars: 1200 });
        if (summary.trim()) lines.push(`User: ${summary.trim()}`);
      }
      continue;
    }

    if (source === "acp" && payload?.type === "session_update") {
      const upd = payload.update as any;
      if (upd?.sessionUpdate === "agent_message_chunk" && upd?.content?.type === "text") {
        const t = upd.content.text;
        if (typeof t === "string" && t) {
          agentBuf += t;
          if (agentBuf.length > 1200 || t.includes("\n\n")) flushAgent();
        }
      }
      continue;
    }
  }
  flushAgent();

  if (!lines.length) return "";
  return trimTail(lines.slice(-60).join("\n"), 9000);
}
