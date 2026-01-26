export class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private current: number;

  constructor(private readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new Error("capacity must be > 0");
    this.current = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");

    if (this.current > 0) {
      this.current -= 1;
      return () => this.release();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waiters.indexOf(next);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      const next = () => {
        signal?.removeEventListener("abort", onAbort);
        this.current -= 1;
        resolve(() => this.release());
      };
      this.waiters.push(next);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release() {
    this.current += 1;
    if (this.current <= 0) return;
    const next = this.waiters.shift();
    if (next) next();
  }
}
