import type { RunPlatform } from "../types.js";

export class ContainerPlatform implements RunPlatform {
  readonly kind = "container" as const;

  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string {
    return opts.cwd;
  }
}

