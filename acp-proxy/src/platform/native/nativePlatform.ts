import type { RunPlatform } from "../types.js";

import { mapCwdForHostProcess } from "../../runs/hostCwd.js";
import type { RunRuntime } from "../../runs/runTypes.js";
import { withAuthRetry } from "../../runs/runRuntime.js";

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

  async onSessionCreated(opts: { run: RunRuntime; sessionId: string; createdMeta: unknown }): Promise<void> {
    const run = opts.run;
    if (!run.agent) return;

    const applied = run.autoConfigOptionAppliedSessionIds ?? new Set<string>();
    run.autoConfigOptionAppliedSessionIds = applied;
    if (applied.has(opts.sessionId)) return;

    const configOptions = Array.isArray((opts.createdMeta as any)?.configOptions)
      ? ((opts.createdMeta as any).configOptions as any[])
      : null;
    const modeOpt = configOptions?.find((x) => x && typeof x === "object" && (x as any).id === "mode") as any;
    const currentValue = typeof modeOpt?.currentValue === "string" ? modeOpt.currentValue : "";
    const options = Array.isArray(modeOpt?.options) ? (modeOpt.options as any[]) : null;
    const hasAuto = !!options?.some((o) => o && typeof o === "object" && (o as any).value === "auto");

    if (!hasAuto || !currentValue || currentValue === "auto") return;

    applied.add(opts.sessionId);
    await withAuthRetry(run, () =>
      run.agent!.sendRpc<any>("session/set_config_option", {
        sessionId: opts.sessionId,
        configId: "mode",
        value: "auto",
      }),
    ).catch(() => {});
  }
}
