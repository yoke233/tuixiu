import type { RunPlatform } from "../types.js";

import { mapCwdForHostProcess } from "../../runs/hostCwd.js";

export class NativePlatform implements RunPlatform {
  readonly kind = "native" as const;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string {
    return mapCwdForHostProcess(
      opts.cwd,
      typeof opts.runHostWorkspacePath === "string" ? opts.runHostWorkspacePath : "",
      this.platform,
    );
  }
}
