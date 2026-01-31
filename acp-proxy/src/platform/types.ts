export interface RunPlatform {
  readonly kind: "native" | "container" | "boxlite";
  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string;
}

