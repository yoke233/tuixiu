import { setTimeout as delay } from "node:timers/promises";

import type { ProxyContext } from "../proxyContext.js";
import type { AgentInit } from "../sandbox/ProxySandbox.js";
import type { ProcessHandle } from "../sandbox/types.js";
import { pickSecretValues, redactSecrets } from "../utils/secrets.js";

import type { RunRuntime } from "./runTypes.js";
import { filterAgentInitEnv } from "./agentEnv.js";
import { defaultCwdForRun } from "./workspacePath.js";
import { sendUpdate } from "./updates.js";

const INIT_STEP_PREFIX = "__TUIXIU_INIT_STEP__:";

export function parseInitStepLine(
  line: string,
): { stage: string; status: string; message?: string } | null {
  if (!line.startsWith(INIT_STEP_PREFIX)) return null;
  const raw = line.slice(INIT_STEP_PREFIX.length).trim();
  if (!raw) return null;
  const parts = raw.split(":");
  const stage = parts[0]?.trim();
  const status = parts[1]?.trim() || "progress";
  const message = parts.slice(2).join(":").trim();
  if (!stage) return null;
  return message ? { stage, status, message } : { stage, status };
}

export async function runInitScript(
  ctx: ProxyContext,
  run: RunRuntime,
  init?: AgentInit,
): Promise<boolean> {
  if (ctx.sandbox.provider === "host_process") {
    ctx.log("host_process skip init script", { runId: run.runId });
    return true;
  }

  const script = init?.script?.trim() ?? "";
  if (!script) return true;

  const timeoutSecondsRaw = init?.timeout_seconds ?? 300;
  const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
    ? Math.max(1, Math.min(3600, Number(timeoutSecondsRaw)))
    : 300;

  const envRaw =
    init?.env && typeof init.env === "object" && !Array.isArray(init.env)
      ? { ...(init.env as Record<string, string>) }
      : undefined;
  const env = envRaw ? filterAgentInitEnv(ctx, run.runId, envRaw) : undefined;
  const secrets = pickSecretValues(env);
  const redact = (line: string) => redactSecrets(line, secrets);

  sendUpdate(ctx, run.runId, {
    type: "text",
    text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
  });

  let proc: ProcessHandle;
  try {
    proc = await ctx.sandbox.execProcess({
      instanceName: run.instanceName,
      command: ["bash", "-lc", script],
      cwdInGuest: defaultCwdForRun({
        workspaceProvider: ctx.cfg.sandbox.workspaceProvider ?? "host",
        runId: run.runId,
      }),
      env,
    });
  } catch (err) {
    const message = String(err);
    sendUpdate(ctx, run.runId, {
      type: "init_step",
      stage: "init",
      status: "failed",
      message,
    });
    sendUpdate(ctx, run.runId, { type: "init_result", ok: false, error: message });
    return false;
  }

  const readLines = async (
    stream: ReadableStream<Uint8Array> | undefined,
    label: "stdout" | "stderr",
  ) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n/g);
        buf = parts.pop() ?? "";
        for (const line of parts) {
          const text = redact(line);
          if (!text.trim()) continue;
          const step = parseInitStepLine(text);
          if (step) {
            sendUpdate(ctx, run.runId, { type: "init_step", ...step });
            continue;
          }
          ctx.log("init output", { runId: run.runId, stream: label, text });
          sendUpdate(ctx, run.runId, {
            type: "text",
            text: `[init:${label}] ${text}`,
          });
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      const rest = redact(buf);
      if (rest.trim()) {
        const step = parseInitStepLine(rest);
        if (step) {
          sendUpdate(ctx, run.runId, { type: "init_step", ...step });
        } else {
          ctx.log("init output", { runId: run.runId, stream: label, text: rest });
          sendUpdate(ctx, run.runId, {
            type: "text",
            text: `[init:${label}] ${rest}`,
          });
        }
      }
    }
  };

  const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    proc.onExit?.((info: { code: number | null; signal: string | null }) => resolve(info));
    if (!proc.onExit) resolve({ code: null, signal: null });
  });
  const outP = readLines(proc.stdout, "stdout");
  const errP = readLines(proc.stderr, "stderr");

  const raced = await Promise.race([
    exitP.then((r) => ({ kind: "exit" as const, ...r })),
    delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
  ]);

  if (raced.kind === "timeout") {
    sendUpdate(ctx, run.runId, {
      type: "init_result",
      ok: false,
      error: `timeout after ${timeoutSeconds}s`,
    });
    await proc.close().catch(() => {});
    await Promise.allSettled([outP, errP]);
    return false;
  }

  await Promise.allSettled([outP, errP]);

  if (raced.code !== 0) {
    sendUpdate(ctx, run.runId, {
      type: "init_result",
      ok: false,
      exitCode: raced.code,
      error: `exitCode=${raced.code}`,
    });
    return false;
  }

  sendUpdate(ctx, run.runId, { type: "init_result", ok: true });
  sendUpdate(ctx, run.runId, { type: "text", text: "[init] done" });
  return true;
}
