import type { RunRuntime } from "../runs/runTypes.js";

export interface RunPlatform {
  readonly kind: "native" | "container" | "boxlite";
  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string;
  onSessionCreated?: (opts: { run: RunRuntime; sessionId: string; createdMeta: unknown }) => Promise<void>;
}
