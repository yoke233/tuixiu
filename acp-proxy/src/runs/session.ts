import type { ProxyContext } from "../proxyContext.js";
import { isRecord } from "../utils/validate.js";

import type { RunRuntime } from "./runTypes.js";
import { ensureInitialized, withAuthRetry } from "./runRuntime.js";

type PromptCapabilities = { image?: boolean; audio?: boolean; embeddedContext?: boolean };

export function getPromptCapabilities(initResult: unknown | null): PromptCapabilities {
  const caps = isRecord(initResult) ? (initResult as any).agentCapabilities?.promptCapabilities : null;
  return isRecord(caps) ? (caps as PromptCapabilities) : {};
}

export function assertPromptBlocksSupported(
  prompt: readonly any[],
  promptCapabilities: PromptCapabilities,
): void {
  for (const block of prompt) {
    const type = block?.type;
    switch (type) {
      case "text":
      case "resource_link":
        break;
      case "image":
        if (!promptCapabilities.image) {
          throw new Error("Agent 未启用 promptCapabilities.image，无法发送 image 类型内容");
        }
        break;
      case "audio":
        if (!promptCapabilities.audio) {
          throw new Error("Agent 未启用 promptCapabilities.audio，无法发送 audio 类型内容");
        }
        break;
      case "resource":
        if (!promptCapabilities.embeddedContext) {
          throw new Error(
            "Agent 未启用 promptCapabilities.embeddedContext，无法发送 resource(embedded) 类型内容",
          );
        }
        break;
      default:
        throw new Error(`未知的 ACP content block type: ${String(type)}`);
    }
  }
}

export function composePromptWithContext(
  context: string | undefined,
  prompt: any[],
  promptCapabilities: PromptCapabilities,
): any[] {
  const ctx = context?.trim();
  if (!ctx) return prompt;

  const prelude = [
    "你正在接手一个可能因为进程重启导致 ACP session 丢失的任务。",
    "下面是系统保存的上下文（Issue 信息 + 最近对话节选）。请先阅读、恢复当前进度，然后继续响应用户的新消息。",
    "",
    "=== 上下文开始 ===",
  ].join("\n");
  const suffix = ["=== 上下文结束 ===", "", "用户消息："].join("\n");

  if (promptCapabilities.embeddedContext) {
    return [
      { type: "text", text: prelude },
      {
        type: "resource",
        resource: { uri: "tuixiu://context", mimeType: "text/markdown", text: ctx },
      },
      { type: "text", text: suffix },
      ...prompt,
    ];
  }

  return [{ type: "text", text: [prelude, ctx, suffix].join("\n") }, ...prompt];
}

export async function ensureSessionForPrompt(
  ctx: ProxyContext,
  run: RunRuntime,
  opts: { cwd: string; sessionId?: string | null; context?: string; prompt: any[] },
): Promise<{ sessionId: string; prompt: any[]; created: boolean }> {
  const initResult = await ensureInitialized(ctx, run);
  const promptCapabilities = getPromptCapabilities(initResult);

  const cwd = ctx.platform.resolveCwdForAgent({
    cwd: opts.cwd,
    runHostWorkspacePath: run.hostWorkspacePath ?? null,
  });

  const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
  let prompt = opts.prompt;

  if (!run.agent) throw new Error("agent not connected");

  if (!sessionId) {
    const created = await withAuthRetry(run, () =>
      run.agent!.sendRpc<any>("session/new", { cwd, mcpServers: [] }),
    );
    const createdSessionId = String((created as any)?.sessionId ?? "").trim();
    if (!createdSessionId) throw new Error("session/new 未返回 sessionId");
    run.seenSessionIds.add(createdSessionId);

    // session/new 的返回里通常包含 configOptions，但不一定会立刻触发 session/update 通知。
    // 为了让后端/前端能在“第一条对话输出之前”就知道可配置项，这里把它作为一条合成的 config_option_update 上报。
    try {
      ctx.send({
        type: "acp_update",
        run_id: run.runId,
        prompt_id: run.activePromptId ?? null,
        session_id: createdSessionId,
        update: { sessionUpdate: "session_created", content: { type: "session_created" } },
      });
    } catch (err) {
      ctx.log("failed to send synthetic session_created", {
        runId: run.runId,
        sessionId: createdSessionId,
        err: String(err),
      });
    }
    const configOptions = Array.isArray((created as any)?.configOptions)
      ? ((created as any).configOptions as any[])
      : null;
    if (configOptions) {
      try {
        ctx.send({
          type: "acp_update",
          run_id: run.runId,
          prompt_id: run.activePromptId ?? null,
          session_id: createdSessionId,
          update: { sessionUpdate: "config_option_update", configOptions },
        });
      } catch (err) {
        ctx.log("failed to send synthetic config_option_update", {
          runId: run.runId,
          sessionId: createdSessionId,
          err: String(err),
        });
      }
    }

    try {
      await ctx.platform.onSessionCreated?.({
        run,
        sessionId: createdSessionId,
        createdMeta: created,
      });
    } catch (err) {
      ctx.log("platform.onSessionCreated failed", {
        runId: run.runId,
        sessionId: createdSessionId,
        err: String(err),
      });
    }
    prompt = composePromptWithContext(opts.context, prompt, promptCapabilities);
    return { sessionId: createdSessionId, prompt, created: true };
  }

  if (!run.seenSessionIds.has(sessionId)) {
    run.seenSessionIds.add(sessionId);
    const canLoad = !!(initResult as any)?.agentCapabilities?.loadSession;
    if (canLoad) {
      await withAuthRetry(run, () =>
        run.agent!.sendRpc<any>("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        }),
      ).catch((err) => {
        ctx.log("session/load failed", { runId: run.runId, err: String(err) });
      });
    }
  }

  return { sessionId, prompt, created: false };
}

export function shouldRecreateSession(err: unknown): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("session") || msg.includes("sessionid");
}

