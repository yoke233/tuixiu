import type { RunRuntime } from "./runTypes.js";

type NowFn = () => number;

export class RunManager {
  private readonly runs = new Map<string, RunRuntime>();
  private readonly now: NowFn;

  constructor(opts?: { now?: NowFn }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  get(runId: string): RunRuntime | null {
    return this.runs.get(runId) ?? null;
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  entries(): IterableIterator<[string, RunRuntime]> {
    return this.runs.entries();
  }

  getOrCreate(opts: {
    runId: string;
    instanceName: string;
    keepaliveTtlSeconds: number;
  }): RunRuntime {
    const runId = opts.runId.trim();
    if (!runId) throw new Error("runId 为空");
    const instanceName = opts.instanceName.trim();
    if (!instanceName) throw new Error("instanceName 为空");

    const existing = this.runs.get(runId) ?? null;
    if (existing) {
      if (existing.instanceName !== instanceName) {
        throw new Error("instanceName 与既有运行时不一致");
      }
      existing.keepaliveTtlSeconds = opts.keepaliveTtlSeconds;
      existing.expiresAt = null;
      existing.lastUsedAt = this.now();
      return existing;
    }

    const run: RunRuntime = {
      runId,
      instanceName,
      keepaliveTtlSeconds: opts.keepaliveTtlSeconds,
      expiresAt: null,
      lastUsedAt: this.now(),
      opQueue: Promise.resolve(),
      hostWorkspacePath: null,
      workspaceMounts: undefined,
      agent: null,
      suppressNextAcpExit: false,
      acpClient: null,
      initialized: false,
      initResult: null,
      seenSessionIds: new Set(),
      activePromptId: null,
    };

    this.runs.set(runId, run);
    return run;
  }

  enqueue<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const run = this.runs.get(runId);
    if (!run) throw new Error("run not found");
    const next = run.opQueue.then(task, task);
    run.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}
