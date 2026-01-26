export type AcpTransport = {
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
  onExit?: (cb: (info: { code: number | null; signal: string | null }) => void) => void;
};

export type LaunchOpts = { cwd: string; env?: Record<string, string> };

export interface AgentLauncher {
  launch(opts: LaunchOpts): Promise<AcpTransport>;
}

