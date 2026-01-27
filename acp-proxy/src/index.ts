import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

import { loadConfig } from "./config.js";
import { Semaphore } from "./semaphore.js";
import type { AgentUpdateMessage, IncomingMessage } from "./types.js";
import { AcpBridge } from "./acpBridge.js";
import { DefaultAgentLauncher } from "./launchers/defaultLauncher.js";
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

type ChunkState = { buf: string; lastFlush: number };

function shouldRecreateSession(err: unknown): boolean {
  const msg = String(err ?? "").toLowerCase();
  return msg.includes("session") || msg.includes("sessionid");
}

function composePromptWithContext(
  context: string | undefined,
  prompt: string,
): string {
  const ctx = context?.trim();
  if (!ctx) return prompt;
  return [
    "你正在接手一个可能因为进程重启导致 ACP session 丢失的任务。",
    "下面是系统保存的上下文（Issue 信息 + 最近对话节选）。请先阅读、恢复当前进度，然后继续响应用户的新消息。",
    "",
    "=== 上下文开始 ===",
    ctx,
    "=== 上下文结束 ===",
    "",
    `用户: ${prompt}`,
  ].join("\n");
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
  const configPath =
    pickArg(process.argv.slice(2), "--config") ?? "config.json";
  const cfg = await loadConfig(configPath);

  const sem = new Semaphore(cfg.agent.max_concurrent);

  const runToSession = new Map<string, string>();
  const sessionToRun = new Map<string, string>();
  const chunkBySession = new Map<string, ChunkState>();
  const runToCwd = new Map<string, string>();

  const log = (msg: string, extra?: Record<string, unknown>) => {
    const head = `[proxy] ${msg}`;
    if (extra) console.log(head, extra);
    else console.log(head);
  };

  if (cfg.sandbox.provider === "boxlite_oci") {
    if (!cfg.sandbox.boxlite?.image?.trim()) {
      throw new Error(
        "sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite.image",
      );
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
      await access("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK).catch(
        () => {
          throw new Error(
            "BoxLite 需要 /dev/kvm 可用（Linux/WSL2）。请确认已启用硬件虚拟化并允许当前用户访问 /dev/kvm",
          );
        },
      );
    }

    await import("@boxlite-ai/boxlite").catch(async () => {
      const legacyPkgName: string = "boxlite";
      await import(legacyPkgName).catch(() => {
        throw new Error(
          "未安装 BoxLite Node SDK。请先运行 pnpm install（或 pnpm -C acp-proxy install）；如仍缺失可手动安装：pnpm -C acp-proxy add @boxlite-ai/boxlite（或 pnpm -C acp-proxy add boxlite）",
        );
      });
    });
  }

  const isWsl =
    process.platform === "linux" &&
    !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

  const mapWindowsPathToWsl = (cwd: string): string => {
    const raw = cwd.trim();
    if (!raw) return raw;
    if (!isWsl) return raw;
    if (!cfg.pathMapping || cfg.pathMapping.type !== "windows_to_wsl")
      return raw;

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
        hostPath: mapWindowsPathToWsl(v.hostPath)
          .replace(/\\/g, "/")
          .replace(/\/+$/, ""),
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

  const mapCwd = (cwd: string): string =>
    mapHostPathToBox(mapWindowsPathToWsl(cwd));

  const boxliteWorkspaceMode =
    cfg.sandbox.provider === "boxlite_oci"
      ? (cfg.sandbox.boxlite?.workspaceMode ?? "mount")
      : "mount";

  const isBoxliteCloneMode =
    cfg.sandbox.provider === "boxlite_oci" && boxliteWorkspaceMode === "git_clone";

  const boxliteWorkingDir =
    cfg.sandbox.provider === "boxlite_oci"
      ? (cfg.sandbox.boxlite?.workingDir?.trim()
          ? cfg.sandbox.boxlite.workingDir.trim()
          : "/workspace")
      : "";

  const defaultCwd = isBoxliteCloneMode ? boxliteWorkingDir : mapCwd(cfg.cwd);

  let ws: WebSocket | null = null;

  const send = (payload: unknown) => {
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new Error("ws not connected");
    ws.send(JSON.stringify(payload));
  };

  const sendUpdate = (runId: string, content: unknown) => {
    const msg: AgentUpdateMessage = {
      type: "agent_update",
      run_id: runId,
      content,
    };
    try {
      send(msg);
    } catch (err) {
      log("send agent_update failed", { err: String(err) });
    }
  };

  const flushChunks = (sessionId: string): string => {
    const state = chunkBySession.get(sessionId);
    if (!state || !state.buf) return "";
    const out = state.buf;
    state.buf = "";
    state.lastFlush = Date.now();
    return out;
  };

  const appendChunk = (sessionId: string, text: string): string => {
    const now = Date.now();
    const state = chunkBySession.get(sessionId) ?? { buf: "", lastFlush: now };
    state.buf += text;
    chunkBySession.set(sessionId, state);
    if (
      text.includes("\n") ||
      state.buf.length >= 256 ||
      now - state.lastFlush >= 200
    ) {
      const out = state.buf;
      state.buf = "";
      state.lastFlush = now;
      return out;
    }
    return "";
  };

  const sendChunkUpdate = (runId: string, sessionId: string, text: string) => {
    sendUpdate(runId, {
      type: "session_update",
      session: sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  };

  let sharedBridge: AcpBridge | null = null;

  if (!isBoxliteCloneMode) {
    const sandbox =
      cfg.sandbox.provider === "boxlite_oci"
        ? new BoxliteSandbox({
            log,
            config: {
              image: cfg.sandbox.boxlite?.image ?? "",
              workingDir: cfg.sandbox.boxlite?.workingDir,
              volumes: cfg.sandbox.boxlite?.volumes,
              env: cfg.sandbox.boxlite?.env,
              cpus: cfg.sandbox.boxlite?.cpus,
              memoryMib: cfg.sandbox.boxlite?.memoryMib,
            },
          })
        : new HostProcessSandbox({ log });

    const launcher = new DefaultAgentLauncher({
      sandbox,
      command: cfg.agent_command,
    });

    sharedBridge = new AcpBridge({
      launcher,
      cwd: defaultCwd,
      log,
      onSessionUpdate: (sessionId, update) => {
        const runId = sessionToRun.get(sessionId);
        if (!runId) return;

        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          const flushed = appendChunk(sessionId, update.content.text);
          if (flushed) sendChunkUpdate(runId, sessionId, flushed);
          return;
        }

        const flushed = flushChunks(sessionId);
        if (flushed) sendChunkUpdate(runId, sessionId, flushed);

        sendUpdate(runId, { type: "session_update", session: sessionId, update });
      },
    });
  }

  const setRunSession = (runId: string, sessionId: string) => {
    runToSession.set(runId, sessionId);
    sessionToRun.set(sessionId, runId);
  };

  const setRunCwd = (runId: string, cwd: string) => {
    const value = mapCwd(cwd);
    if (!value) return;
    runToCwd.set(runId, value);
  };

  const getRunCwd = (runId: string, incomingCwd?: string): string => {
    if (isBoxliteCloneMode) return defaultCwd;
    if (typeof incomingCwd === "string" && incomingCwd.trim()) {
      setRunCwd(runId, incomingCwd);
      return runToCwd.get(runId) ?? defaultCwd;
    }
    return runToCwd.get(runId) ?? defaultCwd;
  };

  const registerAgent = () => {
    const baseCaps: Record<string, unknown> = isRecord(cfg.agent.capabilities)
      ? cfg.agent.capabilities
      : {};
    const baseSandbox: Record<string, unknown> = isRecord(baseCaps.sandbox)
      ? baseCaps.sandbox
      : {};
    const baseRuntime: Record<string, unknown> = isRecord(baseCaps.runtime)
      ? baseCaps.runtime
      : {};
    const baseBoxlite: Record<string, unknown> = isRecord(baseSandbox.boxlite)
      ? (baseSandbox.boxlite as Record<string, unknown>)
      : {};

    const runtime: Record<string, unknown> = {
      ...baseRuntime,
      platform: process.platform,
      arch: process.arch,
      isWsl,
      wslDistro: process.env.WSL_DISTRO_NAME ?? null,
    };

    const sandbox: Record<string, unknown> = {
      ...baseSandbox,
      provider: cfg.sandbox.provider,
    };
    if (cfg.sandbox.provider === "boxlite_oci") {
      sandbox.boxlite = {
        ...baseBoxlite,
        image: cfg.sandbox.boxlite?.image ?? null,
        workingDir: cfg.sandbox.boxlite?.workingDir ?? null,
        workspaceMode: boxliteWorkspaceMode,
      };
    }

    send({
      type: "register_agent",
      agent: {
        id: cfg.agent.id,
        name: cfg.agent.name ?? cfg.agent.id,
        max_concurrent: cfg.agent.max_concurrent,
        capabilities: { ...baseCaps, runtime, sandbox },
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

  const boxliteCloneInitScript = [
    "set -euo pipefail",
    "",
    'WORKSPACE="${TUIXIU_WORKSPACE:-/workspace}"',
    'REPO_URL="${TUIXIU_REPO_URL:-}"',
    'BASE_BRANCH="${TUIXIU_DEFAULT_BRANCH:-main}"',
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
    '  *Username*) echo "$user" ;;',
    '  *Password*) echo "$token" ;;',
    "  *) echo \"\" ;;",
    "esac",
    "EOF",
    'chmod +x "$ASKPASS"',
    'export GIT_ASKPASS="$ASKPASS"',
    'export GIT_TERMINAL_PROMPT=0',
    "",
    'if [ ! -d .git ]; then',
    '  echo "[tuixiu] git clone $REPO_URL"',
    '  git clone "$REPO_URL" .',
    "else",
    '  echo "[tuixiu] workspace already has .git; skipping clone"',
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
    "",
    'echo "[tuixiu] ready: $(pwd) (branch=$(git rev-parse --abbrev-ref HEAD))"',
  ].join("\n");

  type CloneRunState = {
    bridge: AcpBridge;
    sandbox: BoxliteSandbox;
    inited: boolean;
  };

  const cloneRuns = new Map<string, CloneRunState>();

  const clearRunState = (runId: string) => {
    const sessionId = runToSession.get(runId) ?? "";
    runToSession.delete(runId);
    runToCwd.delete(runId);
    if (sessionId) {
      sessionToRun.delete(sessionId);
      chunkBySession.delete(sessionId);
    }
  };

  const cleanupCloneRun = async (runId: string, reason: string) => {
    const state = cloneRuns.get(runId);
    cloneRuns.delete(runId);
    clearRunState(runId);
    if (!state) return;

    try {
      await state.sandbox.stopBox();
    } catch (err) {
      log(`[run:${runId}] stop box failed`, { err: String(err), reason });
    }
  };

  const ensureCloneRun = (runId: string, initEnv: Record<string, string> | undefined): CloneRunState => {
    const existing = cloneRuns.get(runId);
    if (existing) return existing;

    const askpassPath = `${boxliteWorkingDir.replace(/\/+$/, "")}/.tuixiu/askpass.sh`;
    const envForAgent = {
      ...(initEnv ?? {}),
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpassPath,
    };

    const sandbox = new BoxliteSandbox({
      log: (msg, extra) => log(`[run:${runId}] ${msg}`, extra),
      config: {
        image: cfg.sandbox.boxlite?.image ?? "",
        workingDir: boxliteWorkingDir,
        volumes: undefined,
        env: cfg.sandbox.boxlite?.env,
        cpus: cfg.sandbox.boxlite?.cpus,
        memoryMib: cfg.sandbox.boxlite?.memoryMib,
      },
    });

    const launcher = new DefaultAgentLauncher({
      sandbox,
      command: cfg.agent_command,
      env: envForAgent,
    });

    const bridge = new AcpBridge({
      launcher,
      cwd: boxliteWorkingDir,
      log: (msg, extra) => log(`[run:${runId}] ${msg}`, extra),
      onSessionUpdate: (sessionId, update) => {
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text"
        ) {
          const flushed = appendChunk(sessionId, update.content.text);
          if (flushed) sendChunkUpdate(runId, sessionId, flushed);
          return;
        }

        const flushed = flushChunks(sessionId);
        if (flushed) sendChunkUpdate(runId, sessionId, flushed);

        sendUpdate(runId, { type: "session_update", session: sessionId, update });
      },
    });

    const created: CloneRunState = { bridge, sandbox, inited: false };
    cloneRuns.set(runId, created);
    return created;
  };

  const runInitScriptBoxlite = async (opts: {
    runId: string;
    cwd: string;
    sandbox: BoxliteSandbox;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }): Promise<boolean> => {
    const extra = opts.init?.script?.trim() ?? "";
    const script = `${boxliteCloneInitScript}\n\n${extra}`.trim();
    if (!script) return true;

    const timeoutSecondsRaw = opts.init?.timeout_seconds ?? 900;
    const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
      ? Math.max(1, Math.min(3600, timeoutSecondsRaw))
      : 900;

    const env = opts.init?.env ?? {};
    const secrets = pickSecretValues(opts.init?.env);

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

    if (raced.code === 0) {
      sendUpdate(opts.runId, { type: "text", text: "[init] done" });
      sendUpdate(opts.runId, { type: "init_result", ok: true, exitCode: 0 });
      return true;
    }

    sendUpdate(opts.runId, {
      type: "init_result",
      ok: false,
      exitCode: raced.code,
      error: `exitCode=${raced.code}`,
    });
    return false;
  };

  const runInitScript = async (opts: {
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

    const env = opts.init?.env
      ? { ...process.env, ...opts.init.env }
      : process.env;
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

    const makeLineSink = (label: "stdout" | "stderr") => {
      let buf = "";
      return {
        onChunk(chunk: Buffer) {
          buf += chunk.toString("utf8");
          const parts = buf.split(/\r?\n/g);
          buf = parts.pop() ?? "";
          for (const line of parts) {
            const text = redactSecrets(line, secrets);
            if (!text.trim()) continue;
            sendUpdate(opts.runId, {
              type: "text",
              text: `[init:${label}] ${text}`,
            });
          }
        },
        flush() {
          const text = redactSecrets(buf, secrets);
          if (text.trim())
            sendUpdate(opts.runId, {
              type: "text",
              text: `[init:${label}] ${text}`,
            });
          buf = "";
        },
      };
    };

    const out = makeLineSink("stdout");
    const err = makeLineSink("stderr");
    proc.stdout?.on("data", (c: Buffer) => out.onChunk(c));
    proc.stderr?.on("data", (c: Buffer) => err.onChunk(c));

    const exitP = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const errorP = new Promise<Error>((resolve) => {
      proc.once("error", (e) => resolve(e));
    });

    const raced = await Promise.race([
      exitP.then((r) => ({ kind: "exit" as const, ...r })),
      errorP.then((e) => ({ kind: "error" as const, error: e })),
      delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raced.kind === "timeout") {
      sendUpdate(opts.runId, {
        type: "text",
        text: `[init] timeout after ${timeoutSeconds}s`,
      });
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      const { code, signal } = await exitP.catch(() => ({
        code: null,
        signal: null,
      }));
      out.flush();
      err.flush();
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: code,
        error: `timeout (signal=${String(signal ?? "")})`,
      });
      return false;
    }

    if (raced.kind === "error") {
      out.flush();
      err.flush();
      sendUpdate(opts.runId, {
        type: "init_result",
        ok: false,
        exitCode: null,
        error: String(raced.error),
      });
      return false;
    }

    out.flush();
    err.flush();

    if (raced.code === 0) {
      sendUpdate(opts.runId, { type: "text", text: "[init] done" });
      sendUpdate(opts.runId, { type: "init_result", ok: true, exitCode: 0 });
      return true;
    }

    sendUpdate(opts.runId, {
      type: "init_result",
      ok: false,
      exitCode: raced.code,
      error: `exitCode=${raced.code}`,
    });
    return false;
  };

  const handleExecuteTask = async (msg: {
    run_id: string;
    prompt: string;
    cwd?: string;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: `[mock] received prompt: ${msg.prompt}`,
        });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id, msg.cwd);

      if (isBoxliteCloneMode) {
        if (!msg.init?.env?.TUIXIU_REPO_URL?.trim()) {
          sendUpdate(msg.run_id, {
            type: "text",
            text: "boxlite git_clone 模式缺少 init.env.TUIXIU_REPO_URL（后端需下发 repoUrl/token/branch 等 env）",
          });
          return;
        }

        const state = ensureCloneRun(msg.run_id, msg.init.env);

        await state.bridge.ensureInitialized();

        if (!state.inited) {
          const initOk = await runInitScriptBoxlite({
            runId: msg.run_id,
            cwd,
            sandbox: state.sandbox,
            init: msg.init,
          });
          if (!initOk) {
            await cleanupCloneRun(msg.run_id, "init_failed");
            return;
          }
          state.inited = true;
        }

        let sessionId = runToSession.get(msg.run_id) ?? "";
        if (!sessionId) {
          const s = await state.bridge.newSession(cwd);
          sessionId = s.sessionId;
          setRunSession(msg.run_id, sessionId);

          sendUpdate(msg.run_id, {
            type: "session_created",
            session_id: sessionId,
          });
        }

        const res = await state.bridge.prompt(sessionId, msg.prompt);
        const flushed = flushChunks(sessionId);
        if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);

        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: res.stopReason,
        });
        return;
      }

      const initOk = await runInitScript({
        runId: msg.run_id,
        cwd,
        init: msg.init,
      });
      if (!initOk) return;

      if (!sharedBridge) throw new Error("ACP bridge not initialized");
      await sharedBridge.ensureInitialized();

      let sessionId = runToSession.get(msg.run_id) ?? "";
      if (!sessionId) {
        const s = await sharedBridge.newSession(cwd);
        sessionId = s.sessionId;
        setRunSession(msg.run_id, sessionId);

        sendUpdate(msg.run_id, {
          type: "session_created",
          session_id: sessionId,
        });
      }

      const res = await sharedBridge.prompt(sessionId, msg.prompt);
      const flushed = flushChunks(sessionId);
      if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);

      sendUpdate(msg.run_id, {
        type: "prompt_result",
        stopReason: res.stopReason,
      });
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: `执行失败: ${String(err)}`,
      });
    } finally {
      release();
    }
  };

  const handlePromptRun = async (msg: {
    run_id: string;
    prompt: string;
    session_id?: string;
    context?: string;
    cwd?: string;
    init?: {
      script: string;
      timeout_seconds?: number;
      env?: Record<string, string>;
    };
  }) => {
    const release = await sem.acquire();
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: `[mock] prompt: ${msg.prompt}`,
        });
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: "end_turn",
        });
        return;
      }

      const cwd = getRunCwd(msg.run_id, msg.cwd);

      if (isBoxliteCloneMode) {
        if (!msg.init?.env?.TUIXIU_REPO_URL?.trim()) {
          sendUpdate(msg.run_id, {
            type: "text",
            text: "boxlite git_clone 模式缺少 init.env.TUIXIU_REPO_URL（用于重建 workspace）",
          });
          return;
        }

        const state = ensureCloneRun(msg.run_id, msg.init.env);
        await state.bridge.ensureInitialized();

        if (!state.inited) {
          const initOk = await runInitScriptBoxlite({
            runId: msg.run_id,
            cwd,
            sandbox: state.sandbox,
            init: msg.init,
          });
          if (!initOk) {
            await cleanupCloneRun(msg.run_id, "init_failed");
            return;
          }
          state.inited = true;
        }

        let sessionId = msg.session_id || runToSession.get(msg.run_id) || "";
        if (!sessionId) {
          const s = await state.bridge.newSession(cwd);
          sessionId = s.sessionId;
          setRunSession(msg.run_id, sessionId);
          sendUpdate(msg.run_id, {
            type: "session_created",
            session_id: sessionId,
          });
          msg = {
            ...msg,
            prompt: composePromptWithContext(msg.context, msg.prompt),
          };
        } else {
          const sessionPreviouslySeen = sessionToRun.has(sessionId);
          setRunSession(msg.run_id, sessionId);
          if (!sessionPreviouslySeen) {
            const ok = await state.bridge.loadSession(sessionId, cwd);
            if (!ok) {
              sendUpdate(msg.run_id, {
                type: "text",
                text: "ACP session 无法 load（可能不支持或已丢失），将尝试直接对话…",
              });
            }
          }
        }

        let res: { stopReason: string };
        try {
          res = await state.bridge.prompt(sessionId, msg.prompt);
        } catch (err) {
          if (shouldRecreateSession(err)) {
            sendUpdate(msg.run_id, {
              type: "text",
              text: "⚠️ ACP session 疑似已丢失：将创建新 session 并注入上下文继续…",
            });
            const s = await state.bridge.newSession(cwd);
            sessionId = s.sessionId;
            setRunSession(msg.run_id, sessionId);
            sendUpdate(msg.run_id, {
              type: "session_created",
              session_id: sessionId,
            });

            const replay = composePromptWithContext(msg.context, msg.prompt);
            res = await state.bridge.prompt(sessionId, replay);
          } else {
            sendUpdate(msg.run_id, {
              type: "text",
              text: `ACP prompt 失败：${String(err)}`,
            });
            return;
          }
        }

        const flushed = flushChunks(sessionId);
        if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);
        sendUpdate(msg.run_id, {
          type: "prompt_result",
          stopReason: res.stopReason,
        });
        return;
      }

      if (!sharedBridge) throw new Error("ACP bridge not initialized");
      await sharedBridge.ensureInitialized();

      let sessionId = msg.session_id || runToSession.get(msg.run_id) || "";
      if (!sessionId) {
        const s = await sharedBridge.newSession(cwd);
        sessionId = s.sessionId;
        setRunSession(msg.run_id, sessionId);
        sendUpdate(msg.run_id, {
          type: "session_created",
          session_id: sessionId,
        });
        msg = {
          ...msg,
          prompt: composePromptWithContext(msg.context, msg.prompt),
        };
      } else {
        const sessionPreviouslySeen = sessionToRun.has(sessionId);
        setRunSession(msg.run_id, sessionId);

        // 仅当本进程没见过该 session 时，尝试 load 历史会话。
        // 若 load 失败（agent 不支持 / session 不存在），不自动新建 session，避免上下文丢失。
        if (!sessionPreviouslySeen) {
          const ok = await sharedBridge.loadSession(sessionId, cwd);
          if (!ok) {
            sendUpdate(msg.run_id, {
              type: "text",
              text: "ACP session 无法 load（可能不支持或已丢失），将尝试直接对话…",
            });
          }
        }
      }

      let res: { stopReason: string };
      try {
        res = await sharedBridge.prompt(sessionId, msg.prompt);
      } catch (err) {
        if (shouldRecreateSession(err)) {
          sendUpdate(msg.run_id, {
            type: "text",
            text: "⚠️ ACP session 疑似已丢失：将创建新 session 并注入上下文继续…",
          });
          const s = await sharedBridge.newSession(cwd);
          sessionId = s.sessionId;
          setRunSession(msg.run_id, sessionId);
          sendUpdate(msg.run_id, {
            type: "session_created",
            session_id: sessionId,
          });

          const replay = composePromptWithContext(msg.context, msg.prompt);
          res = await sharedBridge.prompt(sessionId, replay);
        } else {
          sendUpdate(msg.run_id, {
            type: "text",
            text: `ACP prompt 失败：${String(err)}`,
          });
          return;
        }
      }

      const flushed = flushChunks(sessionId);
      if (flushed) sendChunkUpdate(msg.run_id, sessionId, flushed);
      sendUpdate(msg.run_id, {
        type: "prompt_result",
        stopReason: res.stopReason,
      });
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: `对话失败: ${String(err)}`,
      });
    } finally {
      release();
    }
  };

  const handleCancelTask = async (msg: { run_id: string; session_id?: string }) => {
    try {
      if (cfg.mock_mode) {
        sendUpdate(msg.run_id, {
          type: "text",
          text: "[mock] cancel_task",
        });
        return;
      }

      const sessionId = msg.session_id || runToSession.get(msg.run_id) || "";

      if (isBoxliteCloneMode) {
        if (sessionId && runToSession.has(msg.run_id)) {
          const state = cloneRuns.get(msg.run_id);
          await state?.bridge.cancel(sessionId).catch(() => {});
        }
        await cleanupCloneRun(msg.run_id, "cancel_task");
        return;
      }

      if (!sessionId) return;
      if (!sharedBridge) throw new Error("ACP bridge not initialized");
      await sharedBridge.cancel(sessionId);
    } catch (err) {
      sendUpdate(msg.run_id, {
        type: "text",
        text: "取消失败: " + String(err),
      });
    }
  };

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
              if (!msg || !isRecord(msg) || typeof msg.type !== "string")
                return;

              if (msg.type === "cancel_task" && typeof msg.run_id === "string") {
                void handleCancelTask({
                  run_id: msg.run_id,
                  session_id:
                    typeof msg.session_id === "string" ? msg.session_id : undefined,
                });
                return;
              }

              if (
                msg.type === "execute_task" &&
                typeof msg.run_id === "string" &&
                typeof msg.prompt === "string"
              ) {
                const initRaw = (msg as any).init;
                let init:
                  | {
                      script: string;
                      timeout_seconds?: number;
                      env?: Record<string, string>;
                    }
                  | undefined;
                if (isRecord(initRaw) && typeof initRaw.script === "string") {
                  const envRaw = initRaw.env;
                  const env = isRecord(envRaw)
                    ? Object.fromEntries(
                        Object.entries(envRaw).filter(
                          (entry): entry is [string, string] =>
                            typeof entry[1] === "string",
                        ),
                      )
                    : undefined;
                  const timeoutSeconds =
                    typeof initRaw.timeout_seconds === "number"
                      ? initRaw.timeout_seconds
                      : typeof initRaw.timeout_seconds === "string"
                        ? Number(initRaw.timeout_seconds)
                        : undefined;
                  init = {
                    script: initRaw.script,
                    timeout_seconds: Number.isFinite(timeoutSeconds as number)
                      ? (timeoutSeconds as number)
                      : undefined,
                    env,
                  };
                }
                void handleExecuteTask({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                  init,
                });
                return;
              }

              if (
                msg.type === "prompt_run" &&
                typeof msg.run_id === "string" &&
                typeof msg.prompt === "string"
              ) {
                const initRaw = (msg as any).init;
                let init:
                  | {
                      script: string;
                      timeout_seconds?: number;
                      env?: Record<string, string>;
                    }
                  | undefined;
                if (isRecord(initRaw) && typeof initRaw.script === "string") {
                  const envRaw = initRaw.env;
                  const env = isRecord(envRaw)
                    ? Object.fromEntries(
                        Object.entries(envRaw).filter(
                          (entry): entry is [string, string] =>
                            typeof entry[1] === "string",
                        ),
                      )
                    : undefined;
                  const timeoutSeconds =
                    typeof initRaw.timeout_seconds === "number"
                      ? initRaw.timeout_seconds
                      : typeof initRaw.timeout_seconds === "string"
                        ? Number(initRaw.timeout_seconds)
                        : undefined;
                  init = {
                    script: initRaw.script,
                    timeout_seconds: Number.isFinite(timeoutSeconds as number)
                      ? (timeoutSeconds as number)
                      : undefined,
                    env,
                  };
                }
                void handlePromptRun({
                  run_id: msg.run_id,
                  prompt: msg.prompt,
                  session_id:
                    typeof msg.session_id === "string"
                      ? msg.session_id
                      : undefined,
                  context:
                    typeof msg.context === "string" ? msg.context : undefined,
                  cwd: typeof msg.cwd === "string" ? msg.cwd : undefined,
                  init,
                });
              }
            } catch (err) {
              log("bad ws message", { err: String(err) });
            }
          });
          ws.on("close", () => resolve());
          ws.on("error", (err) => reject(err));
        }).finally(() => {
          ac.abort();
        });
      } catch (err) {
        log("ws error", { err: String(err) });
      } finally {
        try {
          ws?.close();
        } catch {
          // ignore
        }
        ws = null;
        if (isBoxliteCloneMode) {
          await Promise.allSettled(Array.from(cloneRuns.keys()).map((id) => cleanupCloneRun(id, "ws_disconnected")));
        }
      }

      await delay(2000);
    }
  };

  await connectLoop();
}

main().catch((err) => {
  console.error("[proxy] fatal", err);
  process.exitCode = 1;
});
