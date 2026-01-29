import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CliRuntime, type ContainerCli, type RunningProcess } from "../../sandbox/cliRuntime.js";
import type { ProcessHandle } from "../../sandbox/types.js";

export function parseContainerCli(value: string): ContainerCli {
  const v = String(value ?? "").trim();
  if (v === "docker" || v === "podman" || v === "nerdctl") return v;
  throw new Error(`不支持的容器 CLI：${JSON.stringify(v)}（仅支持 docker|podman|nerdctl）`);
}

function bashSingleQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function bashAnsiCString(value: string): string {
  let out = "$'";
  for (const ch of value) {
    if (ch === "\\") {
      out += "\\\\";
      continue;
    }
    if (ch === "'") {
      out += "\\'";
      continue;
    }
    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }
    if (ch === "\t") {
      out += "\\t";
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += ch;
  }
  out += "'";
  return out;
}

function renderInitEnvExports(env: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    lines.push(`export ${key}=${bashAnsiCString(String(value ?? ""))}`);
  }
  return lines;
}

export function buildContainerEntrypointScript(opts: {
  workingDir: string;
  initMarkerPrefix: string;
  initScript?: string;
  initEnv?: Record<string, string>;
}): string {
  const initScript = (opts.initScript ?? "").trim();
  const initEnv = opts.initEnv ?? undefined;

  const lines: string[] = ["set -euo pipefail"];
  lines.push(`workspace=${bashSingleQuote(opts.workingDir)}`);
  lines.push('mkdir -p "$workspace" >/dev/null 2>&1 || true');

  if (initEnv && Object.keys(initEnv).length) {
    const exports = renderInitEnvExports(initEnv);
    if (exports.length) lines.push(...exports);
  }

  if (initScript) {
    lines.push(`marker=${bashSingleQuote(opts.initMarkerPrefix)}`);
    lines.push("set +e");
    lines.push("(");
    lines.push(initScript);
    lines.push(") 1>&2");
    lines.push("code=$?");
    lines.push("set -e");
    lines.push("if [ $code -ne 0 ]; then");
    lines.push('  printf \'%s{"ok":false,"exitCode":%s}\\n\' "$marker" "$code" >&2');
    lines.push("  exit $code");
    lines.push("fi");
    lines.push('printf \'%s{"ok":true}\\n\' "$marker" >&2');
  }

  lines.push("if [ $# -eq 0 ]; then");
  lines.push('  echo "agent_command 为空" >&2');
  lines.push("  exit 2");
  lines.push("fi");
  lines.push('exec "$@"');

  return lines.join("\n");
}

export function processHandleFromRunningProcess(running: RunningProcess): ProcessHandle {
  const proc: ChildProcessWithoutNullStreams = running.proc;

  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const notifyExit = (info: { code: number | null; signal: string | null }) => {
    for (const cb of exitListeners) cb(info);
  };

  proc.once("exit", (code, signal) => {
    notifyExit({ code: code ?? null, signal: signal ?? null });
  });
  proc.once("error", () => {
    notifyExit({ code: 1, signal: null });
  });

  const stdin = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const stdout = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stderr = Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>;

  return {
    stdin,
    stdout,
    stderr,
    close: async () => {
      try {
        running.kill();
      } catch {
        // ignore
      }
    },
    onExit: (cb) => {
      exitListeners.add(cb);
    },
  };
}

export function startContainerOciCliAgent(opts: {
  cli: ContainerCli;
  name: string;
  image: string;
  workingDir: string;
  mounts?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  extraArgs?: string[];
  autoRemove?: boolean;
  initMarkerPrefix: string;
  initScript?: string;
  initEnv?: Record<string, string>;
  agentCommand: string[];
}): ProcessHandle {
  const runtime = new CliRuntime(opts.cli);
  const script = buildContainerEntrypointScript({
    workingDir: opts.workingDir,
    initMarkerPrefix: opts.initMarkerPrefix,
    initScript: opts.initScript,
    initEnv: opts.initEnv,
  });

  const running = runtime.runInteractive({
    name: opts.name,
    image: opts.image,
    autoRemove: opts.autoRemove,
    entrypoint: "bash",
    workingDir: opts.workingDir,
    env: opts.env,
    labels: opts.labels,
    extraArgs: opts.extraArgs,
    mounts: opts.mounts,
    cmd: ["-lc", script, "--", ...opts.agentCommand],
  });

  return processHandleFromRunningProcess(running);
}
