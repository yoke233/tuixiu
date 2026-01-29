import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../config.js";
import { createLogger, type LoggerFn } from "../logger.js";

import type { IncomingMessage } from "../types.js";
import { pickArg } from "./utils/args.js";
import { isRecord } from "./utils/validate.js";
import { RunManager } from "./runs/runManager.js";
import { closeAgent, sendSandboxInstanceStatus } from "./runs/runRuntime.js";
import { createProxySandbox } from "./sandbox/createProxySandbox.js";
import { OrchestratorClient } from "./orchestrator/orchestratorClient.js";
import { handleAcpClose } from "./handlers/handleAcpClose.js";
import { handleAcpOpen } from "./handlers/handleAcpOpen.js";
import { handlePromptSend } from "./handlers/handlePromptSend.js";
import {
  handleSessionCancel,
  handleSessionSetMode,
  handleSessionSetModel,
} from "./handlers/handleSessionControl.js";
import { handleSandboxControl } from "./handlers/handleSandboxControl.js";
import { nowIso, type ProxyContext } from "./proxyContext.js";

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

  const client = new OrchestratorClient({
    url: cfg.orchestrator_url,
    heartbeatSeconds: cfg.heartbeat_seconds,
    log,
  });

  const ctx: ProxyContext = {
    cfg,
    sandbox,
    runs,
    send: client.send.bind(client),
    log,
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord((baseCaps as any).sandbox)
      ? ((baseCaps as any).sandbox as Record<string, unknown>)
      : {};
    const baseRuntime: Record<string, unknown> = isRecord((baseCaps as any).runtime)
      ? ((baseCaps as any).runtime as Record<string, unknown>)
      : {};

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
      terminalEnabled: cfg.sandbox.terminalEnabled,
      agentMode: sandbox.agentMode,
      image: cfg.sandbox.image ?? null,
      workingDir: cfg.sandbox.workingDir ?? null,
    };
    if (cfg.sandbox.provider === "container_oci")
      sandboxCaps.runtime = cfg.sandbox.runtime ?? "docker";
    if (cfg.sandbox.provider === "boxlite_oci")
      sandboxCaps.workspaceMode = cfg.sandbox.workspaceMode ?? "mount";

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
      onConnected: async () => {
        registerAgent();
        await reportInventory().catch((err) =>
          log("report inventory failed", { err: String(err) }),
        );
        log("connected & registered");
      },
      heartbeatPayload: () => ({ type: "heartbeat", agent_id: cfg.agent.id, timestamp: nowIso() }),
    });
  } finally {
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
