import type { LoadedProxyConfig } from "./config.js";

import type { RunPlatform } from "./platform/types.js";
import type { RunManager } from "./runs/runManager.js";
import type { ProxySandbox } from "./sandbox/ProxySandbox.js";

export type Logger = (msg: string, extra?: Record<string, unknown>) => void;
export type SendFn = (payload: unknown) => void;

export type ProxyContext = {
  cfg: LoadedProxyConfig;
  sandbox: ProxySandbox;
  platform: RunPlatform;
  runs: RunManager;
  send: SendFn;
  log: Logger;
};

export const WORKSPACE_GUEST_PATH = "/workspace";
export const DEFAULT_KEEPALIVE_TTL_SECONDS = 1800;

export function nowIso(): string {
  return new Date().toISOString();
}
