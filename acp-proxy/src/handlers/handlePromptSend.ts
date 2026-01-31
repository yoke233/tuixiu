import type { ProxyContext } from "../proxyContext.js";
import {
  assertPromptBlocksSupported,
  composePromptWithContext,
  ensureInitialized,
  ensureRuntime,
  ensureSessionForPrompt,
  getPromptCapabilities,
  runInitScript,
  shouldRecreateSession,
  startAgent,
  withAuthRetry,
} from "../runs/runRuntime.js";
import { defaultCwdForRun } from "../runs/workspacePath.js";

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
      ctx.log("failed to send prompt_result", { runId, err: String(err) });
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
      if (ctx.sandbox.agentMode === "exec") {
        const initOk = await runInitScript(ctx, run, init);
        if (!initOk) throw new Error("init_failed");
        await startAgent(ctx, run, init);
      } else {
        await startAgent(ctx, run, init);
      }

      await ensureInitialized(ctx, run);

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
            if (!run.agent) throw err;
            recreatedFrom = usedSessionId;
            const createdRes = await withAuthRetry(run, () =>
              run.agent!.sendRpc<any>("session/new", { cwd: cwdForAgent, mcpServers: [] }),
            );
            const newSessionId = String((createdRes as any)?.sessionId ?? "").trim();
            if (!newSessionId) throw err;
            run.seenSessionIds.add(newSessionId);
            usedSessionId = newSessionId;
            created = true;

            const replayCaps = getPromptCapabilities(run.initResult);
            const replay = composePromptWithContext(context, prompt, replayCaps);
            assertPromptBlocksSupported(replay, replayCaps);

            res = await withAuthRetry(run, () =>
              run.agent!.sendRpc<any>(
                "session/prompt",
                { sessionId: usedSessionId, prompt: replay },
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
    reply({ ok: false, error: String(err) });
  }
}
