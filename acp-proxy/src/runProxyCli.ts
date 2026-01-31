import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { loadConfig } from "./config.js";
import { createLogger, type LoggerFn } from "./logger.js";

import type { IncomingMessage } from "./types.js";
import { pickArg } from "./utils/args.js";
import { isRecord } from "./utils/validate.js";
import { RunManager } from "./runs/runManager.js";
import { closeAgent, sendSandboxInstanceStatus, sendUpdate } from "./runs/runRuntime.js";
import { createPlatform } from "./platform/createPlatform.js";
import { createProxySandbox } from "./sandbox/createProxySandbox.js";
import { OrchestratorClient } from "./orchestrator/orchestratorClient.js";
import { handleAcpClose } from "./handlers/handleAcpClose.js";
import { handleAcpOpen } from "./handlers/handleAcpOpen.js";
import { handlePromptSend } from "./handlers/handlePromptSend.js";
import {
  handleSessionCancel,
  handleSessionSetMode,
  handleSessionSetModel,
  handleSessionSetConfigOption,
} from "./handlers/handleSessionControl.js";
import { handleSessionPermission } from "./handlers/handleSessionPermission.js";
import { handleSandboxControl } from "./handlers/handleSandboxControl.js";
import { nowIso, type ProxyContext, WORKSPACE_GUEST_PATH } from "./proxyContext.js";
import { reportWorkspaceInventory } from "./workspace/workspaceInventory.js";

type RunProxyCliOpts = {
  configPath?: string;
  profile?: string | null;
  argv?: string[];
  signal?: AbortSignal;
};

export async function runProxyCli(opts?: RunProxyCliOpts): Promise<void> {
  const argv = opts?.argv ?? process.argv.slice(2);
  const configPath =
    opts?.configPath ??
    pickArg(argv, "--config") ??
    (existsSync("config.toml") ? "config.toml" : "config.json");
  const profile = opts?.profile ?? pickArg(argv, "--profile") ?? null;

  const cfg = await loadConfig(configPath, { profile: profile ?? undefined });

  const logger = createLogger();
  const log: LoggerFn = (msg, extra) => {
    if (extra) logger.info(extra, msg);
    else logger.info(msg);
  };

  const sandbox = createProxySandbox(cfg.sandbox, log);
  const runs = new RunManager();

  const isWsl =
    process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const registerProxyTokenOnce = async (): Promise<string | null> => {
    if (!cfg.register_url?.trim() || !cfg.bootstrap_token?.trim()) return null;
    const res = await fetch(cfg.register_url.trim(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-acp-proxy-bootstrap": cfg.bootstrap_token.trim(),
      },
      body: JSON.stringify({ proxyId: cfg.agent.id, name: cfg.agent.name ?? cfg.agent.id }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`register failed: ${res.status} ${text}`);
    }
    const json = (await res.json()) as any;
    const token = String(json?.data?.token ?? "").trim();
    return token || null;
  };

  const registerProxyToken = async (): Promise<string | null> => {
    const registerUrl = cfg.register_url?.trim() ?? "";
    const bootstrapToken = cfg.bootstrap_token?.trim() ?? "";
    if (!registerUrl || !bootstrapToken) return null;

    let attempt = 0;
    for (;;) {
      if (opts?.signal?.aborted) return null;
      attempt += 1;
      try {
        const token = await registerProxyTokenOnce();
        if (token) return token;
        throw new Error("register returned empty token");
      } catch (err) {
        const delayMs = Math.min(10_000, 300 * 2 ** Math.min(6, attempt - 1));
        log("register failed; retrying", {
          attempt,
          delayMs,
          err: err instanceof Error ? err.message : String(err),
        });
        await delay(delayMs, { signal: opts?.signal }).catch(() => {});
      }
    }
  };

  const authToken = cfg.auth_token?.trim() ? cfg.auth_token.trim() : await registerProxyToken();
  const runtimeCfg = authToken ? { ...cfg, auth_token: authToken } : cfg;

  const client = new OrchestratorClient({
    url: runtimeCfg.orchestrator_url,
    heartbeatSeconds: runtimeCfg.heartbeat_seconds,
    log,
    headers: authToken ? { authorization: `Bearer ${authToken}` } : undefined,
  });

  const ctx: ProxyContext = {
    cfg: runtimeCfg,
    sandbox,
    runs,
    platform: createPlatform(runtimeCfg),
    send: client.send.bind(client),
    log,
  };

  try {
    (sandbox as any).setBootstrapReporter?.(
      (info: { runId: string; stage: string; status: string; message?: string }) => {
        sendUpdate(ctx, info.runId, {
          type: "init_step",
          stage: info.stage,
          status: info.status,
          message: info.message,
        });
      },
    );
  } catch {
    // ignore
  }

  async function execSandboxToText(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    timeoutSeconds: number;
  }): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const proc = await sandbox.execProcess({
      instanceName: opts.instanceName,
      command: opts.command,
      cwdInGuest: opts.cwdInGuest,
    });

    let resolveExit!: (info: { code: number | null; signal: string | null }) => void;
    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      resolveExit = resolve;
    });
    proc.onExit?.((info) => resolveExit(info));
    if (!proc.onExit) resolveExit({ code: null, signal: null });

    const readAll = async (stream: ReadableStream<Uint8Array> | undefined) => {
      if (!stream) return "";
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let out = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      return out;
    };

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      delay(opts.timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)]);

    if (raced.kind === "timeout") {
      await proc.close().catch(() => {});
      return { code: 124, stdout, stderr };
    }
    return { code: raced.code ?? 0, stdout, stderr };
  }

  async function probeGitSupport(): Promise<boolean> {
    const instanceName = `acp-proxy-probe-${randomUUID()}`;
    try {
      await sandbox.ensureInstanceRunning({
        runId: instanceName,
        instanceName,
        workspaceGuestPath: WORKSPACE_GUEST_PATH,
        env: undefined,
      });
      const res = await execSandboxToText({
        instanceName,
        command: ["git", "--version"],
        cwdInGuest: WORKSPACE_GUEST_PATH,
        timeoutSeconds: 30,
      });
      return res.code === 0;
    } catch (err) {
      log("probe git failed", { err: String(err) });
      return false;
    } finally {
      await sandbox.removeInstance(instanceName).catch(() => {});
    }
  }

  let cachedGitPushCap: boolean | null = null;
  const resolveGitPushCap = async (): Promise<boolean> => {
    if (cachedGitPushCap !== null) return cachedGitPushCap;
    if (cfg.sandbox.gitPush === false) {
      cachedGitPushCap = false;
      return cachedGitPushCap;
    }
    if ((cfg.sandbox.workspaceMode ?? "mount") === "mount") {
      cachedGitPushCap = true;
      return cachedGitPushCap;
    }
    cachedGitPushCap = await probeGitSupport();
    return cachedGitPushCap;
  };

  const registerAgent = async () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord((baseCaps as any).sandbox)
      ? ((baseCaps as any).sandbox as Record<string, unknown>)
      : {};
    const baseRuntime: Record<string, unknown> = isRecord((baseCaps as any).runtime)
      ? ((baseCaps as any).runtime as Record<string, unknown>)
      : {};

    const terminalEnabled = cfg.sandbox.terminalEnabled === true;
    const runtime: Record<string, unknown> = {
      ...baseRuntime,
      platform: process.platform,
      arch: process.arch,
      isWsl,
      wslDistro: process.env.WSL_DISTRO_NAME ?? null,
    };

    const sandboxCaps: Record<string, unknown> = {
      ...baseSandbox,
      provider: cfg.sandbox.provider,
      terminalEnabled,
      agentMode: sandbox.agentMode,
      image: cfg.sandbox.image ?? null,
      workingDir: cfg.sandbox.workingDir ?? null,
      workspaceMode: cfg.sandbox.workspaceMode ?? "mount",
    };
    sandboxCaps.gitPush = await resolveGitPushCap();
    if (cfg.sandbox.provider === "container_oci")
      sandboxCaps.runtime = cfg.sandbox.runtime ?? "docker";

    ctx.send({
      type: "register_agent",
      agent: {
        id: cfg.agent.id,
        name: cfg.agent.name ?? cfg.agent.id,
        max_concurrent: cfg.agent.max_concurrent,
        capabilities: {
          ...baseCaps,
          runtime,
          sandbox: sandboxCaps,
          acpTunnel: true,
        },
      },
    });
  };

  const reportInventory = async () => {
    const capturedAt = nowIso();
    const inventoryId = randomUUID();
    const instances = await sandbox.listInstances({ managedOnly: true });
    ctx.send({
      type: "sandbox_inventory",
      inventory_id: inventoryId,
      provider: sandbox.provider,
      runtime: sandbox.provider === "container_oci" ? (sandbox.runtime ?? null) : null,
      captured_at: capturedAt,
      instances: instances.map((i) => {
        const runId = i.instanceName.startsWith("tuixiu-run-")
          ? i.instanceName.slice("tuixiu-run-".length)
          : null;
        return {
          instance_name: i.instanceName,
          run_id: runId,
          status: i.status,
          created_at: i.createdAt,
          last_seen_at: capturedAt,
        };
      }),
    });
  };

  let inventoryTimer: ReturnType<typeof setInterval> | null = null;
  const clearInventoryTimer = () => {
    if (!inventoryTimer) return;
    try {
      clearInterval(inventoryTimer);
    } catch {
      // ignore
    }
    inventoryTimer = null;
  };

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, run] of runs.entries()) {
      if (run.expiresAt == null) continue;
      if (now <= run.expiresAt) continue;
      void (async () => {
        await closeAgent(ctx, run, "keepalive_expired");
        await sandbox.removeInstance(run.instanceName).catch((err) => {
          log("sandbox remove failed", { runId, instanceName: run.instanceName, err: String(err) });
        });
        sendSandboxInstanceStatus(ctx, {
          runId,
          instanceName: run.instanceName,
          status: "missing",
          lastError: null,
        });
        runs.delete(runId);
        log("run expired & removed", { runId, instanceName: run.instanceName });
      })();
    }
  }, 60_000);
  cleanupTimer.unref?.();

  const onMessage = (msg: IncomingMessage) => {
    if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;

    try {
      if (msg.type === "acp_open") {
        void handleAcpOpen(ctx, msg);
        return;
      }
      if (msg.type === "prompt_send") {
        void handlePromptSend(ctx, msg);
        return;
      }
      if (msg.type === "session_cancel") {
        void handleSessionCancel(ctx, msg);
        return;
      }
      if (msg.type === "session_set_mode") {
        void handleSessionSetMode(ctx, msg);
        return;
      }
      if (msg.type === "session_set_model") {
        void handleSessionSetModel(ctx, msg);
        return;
      }
      if (msg.type === "session_set_config_option") {
        void handleSessionSetConfigOption(ctx, msg);
        return;
      }
      if (msg.type === "session_permission") {
        void handleSessionPermission(ctx, msg);
        return;
      }
      if (msg.type === "acp_close") {
        void handleAcpClose(ctx, msg);
        return;
      }
      if (msg.type === "sandbox_control") {
        void handleSandboxControl(ctx, msg);
        return;
      }
    } catch (err) {
      log("failed to dispatch ws message", { err: String(err) });
    }
  };

  try {
    await client.connectLoop({
      signal: opts?.signal,
      onMessage,
      onDisconnected: async () => {
        clearInventoryTimer();
      },
      onConnected: async () => {
        clearInventoryTimer();
        await registerAgent();
        await reportInventory().catch((err) =>
          log("report inventory failed", { err: String(err) }),
        );
        await reportWorkspaceInventory(ctx).catch((err) =>
          log("report workspace inventory failed", { err: String(err) }),
        );

        const intervalSeconds =
          typeof runtimeCfg.inventory_interval_seconds === "number" &&
          Number.isFinite(runtimeCfg.inventory_interval_seconds)
            ? Math.max(0, runtimeCfg.inventory_interval_seconds)
            : 300;
        if (intervalSeconds > 0) {
          inventoryTimer = setInterval(() => {
            void reportInventory().catch((err) =>
              log("report inventory failed", { err: String(err) }),
            );
          }, intervalSeconds * 1000);
          inventoryTimer.unref?.();
        }

        log("connected & registered", { inventoryIntervalSeconds: intervalSeconds });
      },
      heartbeatPayload: () => ({ type: "heartbeat", agent_id: cfg.agent.id, timestamp: nowIso() }),
    });
  } finally {
    clearInventoryTimer();
    try {
      cleanupTimer.unref?.();
    } catch {
      // ignore
    }
    try {
      clearInterval(cleanupTimer);
    } catch {
      // ignore
    }
  }
}
