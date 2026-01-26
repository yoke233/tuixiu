export type ProcessHandle = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
  onExit?: (cb: (info: { code: number | null; signal: string | null }) => void) => void;
};

export type RunProcessOpts = { command: string[]; cwd: string; env?: Record<string, string> };

export interface SandboxProvider {
  runProcess(opts: RunProcessOpts): Promise<ProcessHandle>;
}

