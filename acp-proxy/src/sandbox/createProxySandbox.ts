import type { LoadedProxyConfig } from "../config.js";

import type { ProxySandbox } from "./ProxySandbox.js";
import { BoxliteProxySandbox } from "./boxliteProxySandbox.js";
import { BubblewrapProxySandbox } from "./bubblewrapProxySandbox.js";
import { HostProcessProxySandbox } from "./hostProcessProxySandbox.js";
import { OciCliProxySandbox } from "./ociCliProxySandbox.js";

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export function createProxySandbox(
  sandboxCfg: LoadedProxyConfig["sandbox"],
  log: Logger,
): ProxySandbox {
  if (sandboxCfg.provider === "bwrap") {
    return new BubblewrapProxySandbox({ config: sandboxCfg as any, log });
  }
  if (sandboxCfg.provider === "container_oci") {
    return new OciCliProxySandbox({ config: sandboxCfg as any, log });
  }
  if (sandboxCfg.provider === "host_process") {
    return new HostProcessProxySandbox({ config: sandboxCfg as any, log });
  }
  return new BoxliteProxySandbox({ config: sandboxCfg as any, log });
}
