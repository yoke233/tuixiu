import type { SendToAgent } from "../../db.js";
import { uuidv7 } from "../../utils/uuid.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

type SandboxControlResult = {
  ok?: boolean;
  error?: string;
  action?: string;
  request_id?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
};

type PendingRequest = {
  proxyId: string;
  resolve: (value: SandboxControlResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

export type SandboxControlClient = {
  gitPush: (opts: {
    proxyId: string;
    runId: string;
    instanceName: string;
    branch: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    remote?: string;
  }) => Promise<SandboxControlResult>;
  handlers: {
    handleSandboxControlResult: (proxyId: string, payload: unknown) => void;
    handleProxyDisconnected: (proxyId: string) => void;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseResult(payload: unknown): SandboxControlResult {
  if (!isRecord(payload)) return {};
  return {
    ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
    error: typeof payload.error === "string" ? payload.error : undefined,
    action: typeof payload.action === "string" ? payload.action : undefined,
    request_id: typeof payload.request_id === "string" ? payload.request_id : undefined,
    stdout: typeof payload.stdout === "string" ? payload.stdout : undefined,
    stderr: typeof payload.stderr === "string" ? payload.stderr : undefined,
    code: typeof payload.code === "number" ? payload.code : null,
    signal: typeof payload.signal === "string" ? payload.signal : null,
  };
}

export function createSandboxControlClient(deps: {
  sendToAgent: SendToAgent;
  log?: Logger;
}): SandboxControlClient {
  const pending = new Map<string, PendingRequest>();
  const pendingByProxy = new Map<string, Set<string>>();

  const trackPending = (requestId: string, proxyId: string, entry: PendingRequest) => {
    pending.set(requestId, entry);
    const set = pendingByProxy.get(proxyId) ?? new Set<string>();
    set.add(requestId);
    pendingByProxy.set(proxyId, set);
  };

  const clearPending = (requestId: string) => {
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(requestId);
    const set = pendingByProxy.get(entry.proxyId);
    if (set) {
      set.delete(requestId);
      if (!set.size) pendingByProxy.delete(entry.proxyId);
    }
  };

  async function requestGitPush(opts: {
    proxyId: string;
    runId: string;
    instanceName: string;
    branch: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutSeconds?: number;
    remote?: string;
  }): Promise<SandboxControlResult> {
    const requestId = uuidv7();
    const timeoutSeconds =
      typeof opts.timeoutSeconds === "number" && Number.isFinite(opts.timeoutSeconds)
        ? Math.max(5, Math.min(3600, Math.trunc(opts.timeoutSeconds)))
        : 300;

    const result = await new Promise<SandboxControlResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`sandbox_control timeout after ${timeoutSeconds}s`));
      }, timeoutSeconds * 1000);

      trackPending(requestId, opts.proxyId, { proxyId: opts.proxyId, resolve, reject, timeout });

      deps.sendToAgent(opts.proxyId, {
        type: "sandbox_control",
        action: "git_push",
        request_id: requestId,
        run_id: opts.runId,
        instance_name: opts.instanceName,
        branch: opts.branch,
        cwd: opts.cwd,
        env: opts.env,
        timeout_seconds: timeoutSeconds,
        ...(opts.remote ? { remote: opts.remote } : {}),
      });
    });

    return result;
  }

  return {
    gitPush: requestGitPush,
    handlers: {
      handleSandboxControlResult: (proxyId: string, payload: unknown) => {
        const parsed = parseResult(payload);
        const requestId = parsed.request_id?.trim();
        if (!requestId) return;
        const entry = pending.get(requestId);
        if (!entry) return;
        clearPending(requestId);
        if (parsed.ok) entry.resolve(parsed);
        else entry.reject(new Error(parsed.error || "sandbox_control_failed"));
      },
      handleProxyDisconnected: (proxyId: string) => {
        const ids = pendingByProxy.get(proxyId);
        if (!ids) return;
        pendingByProxy.delete(proxyId);
        for (const id of ids) {
          const entry = pending.get(id);
          if (!entry) continue;
          clearPending(id);
          entry.reject(new Error("proxy disconnected"));
        }
      },
    },
  };
}
