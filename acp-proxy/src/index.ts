import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import * as acp from "@agentclientprotocol/sdk";
import WebSocket from "ws";

import { loadConfig } from "./config.js";
import type { AgentUpdateMessage, IncomingMessage } from "./types.js";
import { DefaultAgentLauncher } from "./launchers/defaultLauncher.js";
import type { AcpTransport, AgentLauncher } from "./launchers/types.js";
import { HostProcessSandbox } from "./sandbox/hostProcessSandbox.js";
import { BoxliteSandbox } from "./sandbox/boxliteSandbox.js";

function pickArg(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  for (const a of args) {
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 6) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function pickSecretValues(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const secretKeys = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
  ];
  const out: string[] = [];
  for (const k of secretKeys) {
    const v = env[k];
    if (typeof v === "string" && v.trim().length >= 6) out.push(v.trim());
  }
  return out;
}

async function main() {
  const configPath = pickArg(process.argv.slice(2), "--config") ?? "config.json";
  const cfg = await loadConfig(configPath);

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const head = `[proxy] ${msg}`;
    if (extra) console.log(head, extra);
    else console.log(head);
  };

  if (cfg.sandbox.provider === "boxlite_oci") {
    if (!cfg.sandbox.boxlite?.image?.trim()) {
      throw new Error("sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite.image");
    }

    if (process.platform === "win32") {
      throw new Error(
        "BoxLite 不支持 Windows 原生运行，请在 WSL2/Linux 或 macOS(Apple Silicon) 上运行 acp-proxy，或改用 sandbox.provider=host_process",
      );
    }

    if (process.platform === "darwin" && process.arch !== "arm64") {
      throw new Error(
        "BoxLite 仅支持 macOS Apple Silicon(arm64)。Intel Mac 请改用 sandbox.provider=host_process 或在 Linux/WSL2 上运行 acp-proxy",
      );
    }

    if (process.platform === "linux") {
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK).catch(() => {
        throw new Error(
          "BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm",
        );
      });
    }
  }

  const isWsl = process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const mapWindowsPathToWsl = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (!isWsl) return raw;
    if (!cfg.pathMapping || cfg.pathMapping.type !== "windows_to_wsl") return raw;

    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(raw);
    if (!m) return raw;

    const drive = m[1].toLowerCase();
    const rest = m[2].replace(/\\/g, "/");
    const mountRoot = cfg.pathMapping.wslMountRoot.replace(/[\\/]+$/, "");

    return rest ? `${mountRoot}/${drive}/${rest}` : `${mountRoot}/${drive}`;
  };

  const mapHostPathToBox = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (cfg.sandbox.provider !== "boxlite_oci") return raw;
    const volumes = cfg.sandbox.boxlite?.volumes ?? [];
    if (!volumes.length) return raw;

    const norm = raw.replace(/\\/g, "/");

    const candidates = volumes
      .map((v) => ({
        hostPath: mapWindowsPathToWsl(v.hostPath).replace(/\\/g, "/").replace(/\/+$/, ""),
        guestPath: v.guestPath.replace(/\\/g, "/").replace(/\/+$/, ""),
      }))
      .filter((v) => v.hostPath && v.guestPath);

    let best: { hostPath: string; guestPath: string } | null = null;
    for (const v of candidates) {
      if (norm === v.hostPath || norm.startsWith(`${v.hostPath}/`)) {
        if (!best || v.hostPath.length > best.hostPath.length) best = v;
      }
    }

    if (!best) return norm;
    return `${best.guestPath}${norm.slice(best.hostPath.length)}`;
  };

  const mapCwd = (cwd: string): string => mapHostPathToBox(mapWindowsPathToWsl(cwd));

  const boxliteWorkspaceMode =
    cfg.sandbox.provider === "boxlite_oci"
      ? (cfg.sandbox.boxlite?.workspaceMode ?? "mount")
      : "mount";

  const isBoxliteGitClone =
    cfg.sandbox.provider === "boxlite_oci" && boxliteWorkspaceMode === "git_clone";

  const boxliteWorkingDir =
    cfg.sandbox.provider === "boxlite_oci"
      ? (cfg.sandbox.boxlite?.workingDir?.trim()
          ? cfg.sandbox.boxlite.workingDir.trim()
          : "/workspace")
      : "";

  const defaultCwd = isBoxliteGitClone ? boxliteWorkingDir : mapCwd(cfg.cwd);

  const hostSandbox = new HostProcessSandbox({ log });
  const hostLauncher = new DefaultAgentLauncher({
    sandbox: hostSandbox,
    command: cfg.agent_command,
  });

  const createBoxliteSandbox = (runId: string) =>
    new BoxliteSandbox({
      log: (msg, extra) => log(`[run:${runId}] ${msg}`, extra),
      config: {
        image: cfg.sandbox.boxlite?.image ?? "",
        workingDir: cfg.sandbox.boxlite?.workingDir,
        volumes: cfg.sandbox.boxlite?.volumes,
        env: cfg.sandbox.boxlite?.env,
        cpus: cfg.sandbox.boxlite?.cpus,
        memoryMib: cfg.sandbox.boxlite?.memoryMib,
      },
    });

  type RunState = {
    cwd: string;
    envKey: string;
    transport: AcpTransport;
    stream: acp.Stream;
    lastUsedAt: number;
    writeQueue: Promise<void>;
    reader: ReadableStreamDefaultReader<acp.AnyMessage> | null;
  };

  const runStates = new Map<string, RunState>();
  const runToCwd = new Map<string, string>();

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    const msg: AgentUpdateMessage = {
      type: "agent_update",
      run_id: runId,
      content,
    };
    send(msg);
  };

  const setRunCwd = (runId: string, cwd: string) => {
    const value = mapCwd(cwd);
    if (!value) return;
    runToCwd.set(runId, value);
  };

  const getRunCwd = (runId: string, incomingCwd?: string): string => {
    if (isBoxliteGitClone) return defaultCwd;
    if (typeof incomingCwd === "string" && incomingCwd.trim()) {
      setRunCwd(runId, incomingCwd);
      return runToCwd.get(runId) ?? defaultCwd;
    }
    return runToCwd.get(runId) ?? defaultCwd;
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities) ? cfg.agent.capabilities : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox) ? baseCaps.sandbox : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime) ? baseCaps.runtime : {};
    const baseBoxlite: Record<string, unknown> = isRecord(baseSandbox.boxlite) ? (baseSandbox.boxlite as Record<string, unknown>) : {};

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
    };
    if (cfg.sandbox.provider === "boxlite_oci") {
      sandboxCaps.boxlite = {
        ...baseBoxlite,
        image: cfg.sandbox.boxlite?.image ?? null,
        workingDir: cfg.sandbox.boxlite?.workingDir ?? null,
        workspaceMode: cfg.sandbox.boxlite?.workspaceMode ?? "mount",
      };
    }

    send({
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

  const heartbeatLoop = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      await delay(cfg.heartbeat_seconds * 1000, { signal }).catch(() => {});
      if (signal.aborted) break;
      try {
        send({
          type: "heartbeat",
          agent_id: cfg.agent.id,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // ignore
      }
    }
  };

  const closeRun = async (runId: string, reason: string) => {
    const state = runStates.get(runId);
    if (!state) return;
    runStates.delete(runId);
    try {
      state.reader?.releaseLock();
    } catch {
      // ignore
    }
    await state.transport.close().catch(() => {});
    log("run closed", { runId, reason });
  };

  const runInitScriptHost = async (opts: {
    runId: string;
    cwd: string;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }): Promise<boolean> => {
    const script = opts.init?.script?.trim();
    if (!script) return true;

    const timeoutSecondsRaw = opts.init?.timeout_seconds ?? 300;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, timeoutSecondsRaw))
      : 300;

    const env = opts.init?.env ? { ...process.env, ...opts.init.env } : process.env;
    const secrets = pickSecretValues(opts.init?.env);

    sendUpdate(opts.runId, {
      type: "text",
      text: `[init] start (bash, timeout=${timeoutSeconds}s)`,
    });

    const proc = spawn("bash", ["-lc", script], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pump = (stream: NodeJS.ReadableStream, label: string) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const text = redactSecrets(String(chunk ?? ""), secrets).trimEnd();
        if (!text) return;
        sendUpdate(opts.runId, {
          type: "text",
          text: `[init:${label}] ${text}`,
        });
      });
    };
    pump(proc.stdout, "stdout");
    pump(proc.stderr, "stderr");

    const raced = await Promise.race([
      new Promise<{ code: number | null }>((resolve) => {
        proc.once("exit", (code) => resolve({ code }));
        proc.once("error", () => resolve({ code: 1 }));
      }),
      delay(timeoutSeconds * 1000).then(() => ({ code: -1 })),
    ]);

    if (raced.code === -1) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        error: `timeout after ${timeoutSeconds}s`,
      });
      return false;
    }

    if (raced.code !== 0) {
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: raced.code,
        error: `exitCode=${raced.code}`,
      });
      return false;
    }

    sendUpdate(opts.runId, { type: "init_result", ok: true });
    sendUpdate(opts.runId, { type: "text", text: "[init] done" });
    return true;
  };

  const boxliteCloneInitScript = [
    "set -euo pipefail",
    "",
    'WORKSPACE="${TUIXIU_BOX_WORKSPACE:-/workspace}"',
    'REPO_URL="${TUIXIU_REPO_URL:-}"',
    'BASE_BRANCH="${TUIXIU_BASE_BRANCH:-${TUIXIU_DEFAULT_BRANCH:-main}}"',
    'RUN_BRANCH="${TUIXIU_RUN_BRANCH:-}"',
    "",
    'if [ -z "$REPO_URL" ]; then',
    '  echo "[tuixiu] missing TUIXIU_REPO_URL" >&2',
    "  exit 2",
    "fi",
    'if [ -z "$RUN_BRANCH" ]; then',
    '  RUN_BRANCH="run/${TUIXIU_RUN_ID:-run}"',
    "fi",
    "",
    'mkdir -p "$WORKSPACE"',
    'cd "$WORKSPACE"',
    "",
    "# Prepare GIT_ASKPASS so git clone/push can run non-interactively when token is provided.",
    'ASKPASS_DIR="$WORKSPACE/.tuixiu"',
    'ASKPASS="$ASKPASS_DIR/askpass.sh"',
    'mkdir -p "$ASKPASS_DIR"',
    'cat > "$ASKPASS" <<\'EOF\'',
    "#!/bin/sh",
    'prompt="$1"',
    'token="${GH_TOKEN:-${GITHUB_TOKEN:-${GITLAB_TOKEN:-${GITLAB_ACCESS_TOKEN:-}}}}"',
    'if [ -z "$token" ]; then',
    "  exit 1",
    "fi",
    'case "${TUIXIU_REPO_URL:-}" in',
    "  *github.com*) user=\"x-access-token\" ;;",
    "  *) user=\"oauth2\" ;;",
    "esac",
    'case "$prompt" in',
    '  *Username*|*username*) echo "$user" ;;',
    '  *Password*|*password*) echo "$token" ;;',
    "  *) echo \"\" ;;",
    "esac",
    "EOF",
    'chmod +x "$ASKPASS"',
    'export GIT_ASKPASS="$ASKPASS"',
    'export GIT_TERMINAL_PROMPT=0',
    "",
    'if [ ! -d .git ]; then',
    '  echo "[tuixiu] git clone $REPO_URL" >&2',
    '  git clone "$REPO_URL" .',
    "else",
    '  echo "[tuixiu] workspace already has .git; skipping clone" >&2',
    "fi",
    "",
    'git remote set-url origin "$REPO_URL" >/dev/null 2>&1 || true',
    'git fetch origin --prune',
    "",
    "# Checkout run branch: prefer remote branch if it exists; otherwise create from base branch.",
    'if git show-ref --verify --quiet "refs/remotes/origin/$RUN_BRANCH"; then',
    '  git checkout -B "$RUN_BRANCH" "origin/$RUN_BRANCH"',
    "else",
    '  git checkout -B "$RUN_BRANCH" "origin/$BASE_BRANCH"',
    "fi",
    "",
    'git config user.name "${TUIXIU_GIT_NAME:-tuixiu-bot}" >/dev/null 2>&1 || true',
    'git config user.email "${TUIXIU_GIT_EMAIL:-tuixiu-bot@localhost}" >/dev/null 2>&1 || true',
  ].join("\n");

  const runInitScriptBoxlite = async (opts: {
    runId: string;
    cwd: string;
    sandbox: BoxliteSandbox;
    init?: {
      script?: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }): Promise<boolean> => {
    const extra = opts.init?.script?.trim() ?? "";
    const script = `${isBoxliteGitClone ? boxliteCloneInitScript : ""}\n\n${extra}`.trim();
    if (!script) return true;

    const timeoutSecondsRaw = opts.init?.timeout_seconds ?? 900;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, timeoutSecondsRaw))
      : 900;

    const env = { ...(opts.init?.env ?? {}) };
    if (isBoxliteGitClone && !env.TUIXIU_BOX_WORKSPACE) {
      env.TUIXIU_BOX_WORKSPACE = opts.cwd;
    }
    const secrets = pickSecretValues(env);
    const redact = (line: string) => redactSecrets(line, secrets);

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
            sendUpdate(opts.runId, { type: "text", text: `[init:${label}] ${text}` });
          }
        }
      } finally {
        const rest = redact(buf);
        if (rest.trim()) sendUpdate(opts.runId, { type: "text", text: `[init:${label}] ${rest}` });
      }
    };

    sendUpdate(opts.runId, {
      type: "text",
      text: `[init] start (boxlite, bash, timeout=${timeoutSeconds}s)`,
    });

    const proc = await opts.sandbox.execProcess({
      command: ["bash", "-lc", script],
      cwd: opts.cwd,
      env,
    });

    const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.onExit?.((info) => resolve(info));
    });

    const outP = readLines(proc.stdout, "stdout");
    const errP = readLines(proc.stderr, "stderr");

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raced.kind === "timeout") {
      sendUpdate(opts.runId, {
        type: "text",
        text: `[init] timeout after ${timeoutSeconds}s (stopping box)`,
      });
      await opts.sandbox.stopBox();
      await Promise.allSettled([outP, errP]);
      sendUpdate(opts.runId, { type: "init_result", ok: false, exitCode: null, error: "timeout" });
      return false;
    }

    await Promise.allSettled([outP, errP]);

    if (raced.code !== 0) {
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: raced.code,
        error: `exitCode=${raced.code}`,
      });
      return false;
    }

    sendUpdate(opts.runId, { type: "init_result", ok: true });
    sendUpdate(opts.runId, { type: "text", text: "[init] done" });
    return true;
  };

  const normalizeEnvKey = (env: Record<string, string> | undefined): string => {
    if (!env) return "";
    try {
      const keys = Object.keys(env).sort();
      const normalized: Record<string, string> = {};
      for (const k of keys) normalized[k] = String(env[k] ?? "");
      return JSON.stringify(normalized);
    } catch {
      return "";
    }
  };

  const ensureRun = async (
    runId: string,
    cwd: string,
    launcher: AgentLauncher,
    env: Record<string, string> | undefined,
  ): Promise<RunState> => {
    const envKey = normalizeEnvKey(env);
    const existing = runStates.get(runId);
    if (existing && existing.cwd === cwd && existing.envKey === envKey) {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    if (existing) {
      await closeRun(runId, "cwd_changed");
    }

    const transport = await launcher.launch({ cwd, env });
    const stream = acp.ndJsonStream(transport.input, transport.output);

    const state: RunState = {
      cwd,
      envKey,
      transport,
      stream,
      lastUsedAt: Date.now(),
      writeQueue: Promise.resolve(),
      reader: null,
    };
    runStates.set(runId, state);

    transport.onExit?.((info) => {
      void closeRun(runId, "agent_exit").finally(() => {
        try {
          send({ type: "acp_exit", run_id: runId, code: info.code, signal: info.signal });
        } catch {
          // ignore
        }
      });
    });

    const reader = stream.readable.getReader();
    state.reader = reader;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          state.lastUsedAt = Date.now();
          try {
            send({ type: "acp_message", run_id: runId, message: value });
          } catch (err) {
            log("failed to forward acp message", { runId, err: String(err) });
          }
        }
      } catch (err) {
        log("acp stream read failed", { runId, err: String(err) });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    })();

    return state;
  };

  const handleAcpOpen = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;

    const cwd = getRunCwd(runId, typeof msg.cwd === "string" ? msg.cwd : undefined);
    const init = isRecord(msg.init) ? (msg.init as any) : undefined;
    const env = init && isRecord(init.env) ? (init.env as Record<string, string>) : undefined;
    const envKey = normalizeEnvKey(env);

    const existing = runStates.get(runId);
    if (existing && existing.cwd === cwd && existing.envKey === envKey) {
      existing.lastUsedAt = Date.now();
      try {
        send({ type: "acp_opened", run_id: runId, ok: true });
      } catch {
        // ignore
      }
      return;
    }

    try {
      if (cfg.sandbox.provider === "boxlite_oci") {
        const sandbox = createBoxliteSandbox(runId);
        const initOk = await runInitScriptBoxlite({ runId, cwd, sandbox, init });
        if (!initOk) {
          send({ type: "acp_opened", run_id: runId, ok: false, error: "init_failed" });
          return;
        }

        const launcher = new DefaultAgentLauncher({ sandbox, command: cfg.agent_command });
        await ensureRun(runId, cwd, launcher, env);
      } else {
        const initOk = await runInitScriptHost({ runId, cwd, init });
        if (!initOk) {
          send({ type: "acp_opened", run_id: runId, ok: false, error: "init_failed" });
          return;
        }
        await ensureRun(runId, cwd, hostLauncher, env);
      }

      send({ type: "acp_opened", run_id: runId, ok: true });
    } catch (err) {
      send({ type: "acp_opened", run_id: runId, ok: false, error: String(err) });
    }
  };

  const handleAcpMessage = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;
    const state = runStates.get(runId);
    if (!state) {
      send({ type: "acp_error", run_id: runId, error: "run_not_open" });
      return;
    }

    const message = msg.message;
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      send({ type: "acp_error", run_id: runId, error: "invalid_jsonrpc_message" });
      return;
    }

    state.lastUsedAt = Date.now();
    state.writeQueue = state.writeQueue
      .then(async () => {
        const writer = state.stream.writable.getWriter();
        try {
          await writer.write(message as any);
        } finally {
          writer.releaseLock();
        }
      })
      .catch((err) => {
        log("acp write failed", { runId, err: String(err) });
      });
    await state.writeQueue;
  };

  const handleAcpClose = async (msg: any) => {
    const runId = String(msg.run_id ?? "").trim();
    if (!runId) return;

    await closeRun(runId, "requested");
    try {
      send({ type: "acp_closed", run_id: runId, ok: true });
    } catch {
      // ignore
    }
  };

  const idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, state] of runStates) {
      const idleMs = now - state.lastUsedAt;
      if (idleMs < 30 * 60 * 1000) continue;
      void closeRun(runId, "idle_timeout");
    }
  }, 60_000);
  idleTimer.unref?.();

  const connectLoop = async () => {
    for (;;) {
      try {
        log("connecting", { url: cfg.orchestrator_url });
        ws = new WebSocket(cfg.orchestrator_url);
        const ac = new AbortController();

        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error("ws init failed"));
          ws.on("open", () => resolve());
          ws.on("error", (err) => reject(err));
        });

        registerAgent();
        log("connected & registered");
        void heartbeatLoop(ac.signal);

        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error("ws init failed"));
          ws.on("message", (data) => {
            try {
              const text = data.toString();
              const msg = JSON.parse(text) as IncomingMessage;
              if (!msg || !isRecord(msg) || typeof msg.type !== "string") return;

              if (msg.type === "acp_open") {
                void handleAcpOpen(msg);
                return;
              }
              if (msg.type === "acp_message") {
                void handleAcpMessage(msg);
                return;
              }
              if (msg.type === "acp_close") {
                void handleAcpClose(msg);
                return;
              }
            } catch (err) {
              log("failed to handle ws message", { err: String(err) });
            }
          });
          ws.on("close", () => resolve());
          ws.on("error", (err) => reject(err));
        });

        ac.abort();
      } catch (err) {
        log("connection failed; retrying", { err: String(err) });
      } finally {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
      }

      await delay(1000);
    }
  };

  await connectLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

