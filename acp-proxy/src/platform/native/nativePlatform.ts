import type { RunPlatform } from "../types.js";

export class NativePlatform implements RunPlatform {
  readonly kind = "native" as const;

  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string {
    return opts.cwd;
  }
}

