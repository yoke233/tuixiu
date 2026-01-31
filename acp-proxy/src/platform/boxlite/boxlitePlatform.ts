import type { RunPlatform } from "../types.js";

export class BoxlitePlatform implements RunPlatform {
  readonly kind = "boxlite" as const;

  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string {
    return opts.cwd;
  }
}

