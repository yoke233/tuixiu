import type { SandboxConfig } from "../config.js";

import { BoxlitePlatform } from "./boxlite/boxlitePlatform.js";
import { ContainerPlatform } from "./container/containerPlatform.js";
import { NativePlatform } from "./native/nativePlatform.js";
import type { RunPlatform } from "./types.js";

export function createPlatform(cfg: { sandbox: { provider: SandboxConfig["provider"] } }): RunPlatform {
  if (cfg.sandbox.provider === "host_process") return new NativePlatform();
  if (cfg.sandbox.provider === "container_oci") return new ContainerPlatform();
  return new BoxlitePlatform();
}

