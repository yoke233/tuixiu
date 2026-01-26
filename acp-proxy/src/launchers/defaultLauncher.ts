import type { SandboxProvider } from "../sandbox/types.js";
import type { AcpTransport, AgentLauncher, LaunchOpts } from "./types.js";

export class DefaultAgentLauncher implements AgentLauncher {
  constructor(
    private readonly opts: { sandbox: SandboxProvider; command: string[]; env?: Record<string, string> },
  ) {}

  async launch(opts: LaunchOpts): Promise<AcpTransport> {
    const handle = await this.opts.sandbox.runProcess({
      command: this.opts.command,
      cwd: opts.cwd,
      env: { ...this.opts.env, ...opts.env },
    });
    return {
      input: handle.stdin,
      output: handle.stdout,
      close: handle.close,
      onExit: handle.onExit,
    };
  }
}

