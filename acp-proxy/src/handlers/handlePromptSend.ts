import type { ProxyContext } from "../proxyContext.js";
import {
  assertPromptBlocksSupported,
  ensureRuntime,
  ensureSessionForPrompt,
  getPromptCapabilities,
  sendUpdate,
  shouldRecreateSession,
  withAuthRetry,
} from "../runs/runRuntime.js";
import { defaultCwdForRun } from "../runs/workspacePath.js";
import { ensureRunOpen } from "../runs/ensureRunOpen.js";

export async function handlePromptSend(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  if (!runId) return;
  const promptIdRaw = String(msg?.prompt_id ?? "").trim();

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "prompt_result",
        run_id: runId,
        prompt_id: promptIdRaw || null,
        ...payload,
      });
    } catch (err) {
      (ctx.logError ?? ctx.log)("failed to send prompt_result", { runId, err: String(err) });
    }
  };

  try {
    if (!promptIdRaw) {
      reply({ ok: false, error: "prompt_id 为空" });
      return;
    }

    const prompt = Array.isArray(msg?.prompt) ? msg.prompt : null;
    if (!prompt) {
      reply({ ok: false, error: "prompt 必须是数组" });
      return;
    }

    const run = await ensureRuntime(ctx, msg);
    const init =
      msg?.init && typeof msg.init === "object" && !Array.isArray(msg.init) ? msg.init : undefined;
    const initEnv =
      init?.env && typeof init.env === "object" && !Array.isArray(init.env)
        ? (init.env as Record<string, string>)
        : undefined;

    const workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount";
    const defaultCwd = defaultCwdForRun({ workspaceMode, runId });
    const cwd =
      typeof msg?.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : defaultCwd;
    const cwdForAgent = ctx.platform.resolveCwdForAgent({
      cwd,
      runHostWorkspacePath: run.hostWorkspacePath ?? null,
    });
    const sessionId =
      typeof msg?.session_id === "string" && msg.session_id.trim() ? msg.session_id.trim() : null;
    const context = typeof msg?.context === "string" ? msg.context : undefined;

    const promptTimeoutMsRaw = msg?.timeout_ms ?? null;
    const promptTimeoutMs = Number.isFinite(promptTimeoutMsRaw as number)
      ? Math.max(5_000, Math.min(24 * 3600 * 1000, Number(promptTimeoutMsRaw)))
      : 3600_000;

    await ctx.runs.enqueue(run.runId, async () => {
      await ensureRunOpen(ctx, run, { init, initEnv });

      run.activePromptId = promptIdRaw;
      try {
        const ensured = await ensureSessionForPrompt(ctx, run, {
          cwd: cwdForAgent,
          sessionId,
          context,
          prompt,
        });
        const caps = getPromptCapabilities(run.initResult);
        assertPromptBlocksSupported(ensured.prompt, caps);

        let usedSessionId = ensured.sessionId;
        let created = ensured.created;
        let recreatedFrom: string | null = null;

        let res: any;
        try {
          if (!run.agent) throw new Error("agent not connected");
          res = await withAuthRetry(run, () =>
            run.agent!.sendRpc<any>(
              "session/prompt",
              { sessionId: usedSessionId, prompt: ensured.prompt },
              { timeoutMs: promptTimeoutMs },
            ),
          );
        } catch (err) {
          if (shouldRecreateSession(err)) {
            recreatedFrom = usedSessionId;
            const replayEnsured = await ensureSessionForPrompt(ctx, run, {
              cwd: cwdForAgent,
              sessionId: null,
              context,
              prompt,
            });
            usedSessionId = replayEnsured.sessionId;
            created = replayEnsured.created;
            assertPromptBlocksSupported(replayEnsured.prompt, caps);
            res = await withAuthRetry(run, () =>
              run.agent!.sendRpc<any>(
                "session/prompt",
                { sessionId: usedSessionId, prompt: replayEnsured.prompt },
                { timeoutMs: promptTimeoutMs },
              ),
            );
          } else {
            throw err;
          }
        }

        const stopReason = typeof res?.stopReason === "string" ? res.stopReason : "";

        reply({
          ok: true,
          session_id: usedSessionId,
          stop_reason: stopReason || null,
          session_created: created,
          session_recreated_from: recreatedFrom,
        });
      } finally {
        run.activePromptId = null;
      }
    });
  } catch (err) {
    const errText =
      err instanceof Error ? err.stack ?? err.message : String(err);
    (ctx.logError ?? ctx.log)("prompt_send failed", { runId, err: errText });
    // 把 proxy 层的错误显式写入事件流，避免 UI “卡住但无输出”。
    // 典型场景：bwrap/agent 启动失败、RPC 超时（如 authenticate）、或 session/new/prompt 抛错。
    sendUpdate(ctx, runId, { type: "text", text: `[proxy:error] ${err instanceof Error ? err.message : String(err)}` });
    reply({ ok: false, error: String(err) });
  }
}
