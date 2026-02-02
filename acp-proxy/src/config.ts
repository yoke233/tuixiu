import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import convict from "convict";

import { loadOrCreateAgentId } from "./identity/agentIdentity.js";

export type VolumeConfig = {
  hostPath: string;
  guestPath: string;
  readOnly?: boolean;
};

export type SandboxBootstrapConfig = {
  checkCommand?: string[];
  installCommand?: string[];
  timeoutSeconds?: number;
};

export type SandboxConfig = {
  terminalEnabled: boolean;
  provider: "boxlite_oci" | "container_oci" | "host_process" | "bwrap";
  image?: string;
  workingDir?: string;
  volumes?: VolumeConfig[];
  env?: Record<string, string>;
  cpus?: number;
  memoryMib?: number;
  workspaceMode: "mount" | "git_clone";
  gitPush?: boolean;
  workspaceHostRoot: string;
  runtime?: string;
  extraRunArgs?: string[];
  boxMode?: "simple" | "jsbox";
  boxName?: string;
  boxReuse?: "per_instance" | "shared";
  boxAutoRemove?: boolean;
  execTimeoutSeconds?: number;
  execLogIntervalSeconds?: number;
  bootstrap?: SandboxBootstrapConfig;
};

export type AgentConfig = {
  id: string;
  name?: string;
  max_concurrent: number;
  capabilities?: unknown;
};

export type ProxyConfig = {
  orchestrator_url: string;
  register_url?: string;
  bootstrap_token?: string;
  auth_token?: string;
  heartbeat_seconds: number;
  inventory_interval_seconds: number;
  mock_mode: boolean;
  skills_mounting_enabled: boolean;
  skills_download_max_bytes: number;
  agent_env_allowlist: string[];
  sandbox: SandboxConfig;
  agent_command: string[];
  agent: AgentConfig;
};

type ProxyConfigRaw = Omit<ProxyConfig, "sandbox" | "agent"> & {
  sandbox: Omit<SandboxConfig, "cpus" | "memoryMib" | "gitPush" | "boxAutoRemove" | "execTimeoutSeconds" | "execLogIntervalSeconds" | "bootstrap"> & {
    cpus?: number | null;
    memoryMib?: number | null;
    gitPush?: boolean | null;
    boxAutoRemove?: boolean | null;
    execTimeoutSeconds?: number | null;
    execLogIntervalSeconds?: number | null;
    bootstrap?: Omit<SandboxBootstrapConfig, "timeoutSeconds"> & {
      timeoutSeconds?: number | null;
    };
  };
  agent: AgentConfig;
};

export type LoadedProxyConfig = Omit<ProxyConfig, "agent"> & {
  agent: Omit<ProxyConfig["agent"], "name" | "capabilities"> & {
    name: string;
    capabilities: unknown;
  };
};

type ProxyConfigOverride = Partial<Omit<ProxyConfig, "sandbox" | "agent">> & {
  sandbox?: Partial<SandboxConfig>;
  agent?: Partial<AgentConfig>;
};

type RawProxyConfig = ProxyConfig & {
  profiles?: Record<string, ProxyConfigOverride>;
};

const defaultWorkspaceHostRoot = path.join(os.homedir(), ".tuixiu", "workspaces");

let formatsRegistered = false;

function registerFormats() {
  if (formatsRegistered) return;
  formatsRegistered = true;

  convict.addFormat({
    name: "non-empty-string",
    validate(value: unknown) {
      if (typeof value !== "string" || !value.trim()) {
        throw new Error("must be a non-empty string");
      }
    },
    coerce(value: unknown) {
      return typeof value === "string" ? value.trim() : value;
    },
  });

  convict.addFormat({
    name: "boolean-ish",
    validate(value: unknown) {
      if (
        typeof value === "boolean" ||
        value === "1" ||
        value === "0" ||
        value === 1 ||
        value === 0 ||
        value === "true" ||
        value === "false"
      ) {
        return;
      }
      throw new Error("must be a boolean-ish value");
    },
    coerce(value: unknown) {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
      }
      return value;
    },
  });

  convict.addFormat({
    name: "boolean-ish-or-null",
    validate(value: unknown) {
      if (value === null || value === undefined) return;
      if (
        typeof value === "boolean" ||
        value === "1" ||
        value === "0" ||
        value === 1 ||
        value === 0 ||
        value === "true" ||
        value === "false"
      ) {
        return;
      }
      throw new Error("must be a boolean-ish value or null");
    },
    coerce(value: unknown) {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        const v = value.trim().toLowerCase();
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
      }
      return value;
    },
  });

  convict.addFormat({
    name: "int-or-null",
    validate(value: unknown) {
      if (value === null || value === undefined) return;
      if (typeof value === "number" && Number.isInteger(value)) return;
      if (typeof value === "string" && value.trim() && Number.isInteger(Number(value))) return;
      throw new Error("must be an integer or null");
    },
    coerce(value: unknown) {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "number") return value;
      if (typeof value === "string") return Number(value.trim());
      return value;
    },
  });

  convict.addFormat({
    name: "number-or-null",
    validate(value: unknown) {
      if (value === null || value === undefined) return;
      if (typeof value === "number" && Number.isFinite(value)) return;
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return;
      throw new Error("must be a number or null");
    },
    coerce(value: unknown) {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "number") return value;
      if (typeof value === "string") return Number(value.trim());
      return value;
    },
  });

  convict.addFormat({
    name: "optional-enum",
    validate(value: unknown, schema: any) {
      if (value === null || value === undefined || value === "") return;
      const allowed = Array.isArray(schema.allowed) ? schema.allowed : [];
      if (!allowed.includes(value)) throw new Error("invalid enum value");
    },
  });

  convict.addFormat({
    name: "string-array",
    validate(value: unknown) {
      if (!Array.isArray(value)) {
        throw new Error("must be an array of strings");
      }
      for (const item of value) {
        if (typeof item !== "string" || !item.trim()) {
          throw new Error("must be an array of non-empty strings");
        }
      }
    },
    coerce(value: unknown) {
      if (Array.isArray(value)) return value.map((v) => String(v));
      if (typeof value !== "string") return value;
      const raw = value.trim();
      if (!raw) return [];
      if (raw.startsWith("[")) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((v) => String(v)) : value;
      }
      const parts = raw.includes(",") ? raw.split(",") : raw.split(/\s+/);
      return parts.map((v) => v.trim()).filter(Boolean);
    },
  });

  convict.addFormat({
    name: "string-record",
    validate(value: unknown) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("must be an object");
      }
    },
    coerce(value: unknown) {
      if (value === null || value === undefined) return value;
      if (typeof value === "string") {
        const raw = value.trim();
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed;
      }
      if (typeof value === "object") return value;
      return value;
    },
  });

  convict.addFormat({
    name: "volumes-array",
    validate(value: unknown) {
      if (!Array.isArray(value)) {
        throw new Error("must be an array");
      }
    },
    coerce(value: unknown) {
      if (Array.isArray(value)) return value;
      if (typeof value !== "string") return value;
      const raw = value.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return parsed;
    },
  });
}

function mergeSandbox(base: SandboxConfig, override: Partial<SandboxConfig>): SandboxConfig {
  return { ...base, ...override };
}

function mergeConfig(base: ProxyConfig, override: ProxyConfigOverride): ProxyConfig {
  const merged: any = { ...base, ...override };
  if (override.sandbox) merged.sandbox = mergeSandbox(base.sandbox, override.sandbox);
  if (override.agent) merged.agent = { ...base.agent, ...override.agent };
  return merged;
}

function normalizeVolumes(volumes?: Array<Record<string, unknown>>): VolumeConfig[] | undefined {
  if (!volumes?.length) return volumes as VolumeConfig[] | undefined;
  return volumes.map((entry) => {
    const hostPath = typeof entry.hostPath === "string" ? entry.hostPath : entry.source;
    const guestPath = typeof entry.guestPath === "string" ? entry.guestPath : entry.target;
    return {
      hostPath: String(hostPath ?? ""),
      guestPath: String(guestPath ?? ""),
      readOnly: typeof entry.readOnly === "boolean" ? entry.readOnly : undefined,
    };
  });
}

function normalizeSandboxEnv(env?: Record<string, unknown>): Record<string, string> | undefined {
  if (!env) return env as Record<string, string> | undefined;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key) continue;
    next[key] = typeof value === "string" ? value : String(value);
  }
  return next;
}

function normalizeConfig(cfg: ProxyConfigRaw): ProxyConfigRaw {
  const sandbox = { ...cfg.sandbox };
  sandbox.volumes = normalizeVolumes(sandbox.volumes as Array<Record<string, unknown>> | undefined);
  sandbox.env = normalizeSandboxEnv(sandbox.env as Record<string, unknown> | undefined);
  return { ...cfg, sandbox };
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function buildSchema() {
  registerFormats();
  return convict({
    orchestrator_url: {
      doc: "WebSocket url for orchestrator",
      format: "non-empty-string",
      default: "",
      env: "ACP_PROXY_ORCHESTRATOR_URL",
    },
    register_url: {
      doc: "HTTP url to register proxy",
      format: "String",
      default: "",
      env: "ACP_PROXY_REGISTER_URL",
    },
    bootstrap_token: {
      doc: "Bootstrap token for registration",
      format: "String",
      default: "",
      env: "ACP_PROXY_BOOTSTRAP_TOKEN",
    },
    auth_token: {
      doc: "Auth token for proxy",
      format: "String",
      default: "",
      env: "ACP_PROXY_AUTH_TOKEN",
    },
    heartbeat_seconds: {
      doc: "Heartbeat interval seconds",
      format: "int",
      default: 30,
      env: "ACP_PROXY_HEARTBEAT_SECONDS",
    },
    inventory_interval_seconds: {
      doc: "Sandbox inventory report interval seconds (0 disables periodic reporting)",
      format: "int",
      default: 300,
      env: "ACP_PROXY_INVENTORY_INTERVAL_SECONDS",
    },
    mock_mode: {
      doc: "Enable mock mode",
      format: "boolean-ish",
      default: false,
      env: "ACP_PROXY_MOCK_MODE",
    },
    skills_mounting_enabled: {
      doc: "Enable runtime skills mounting (requires backend project flag too)",
      format: "boolean-ish",
      default: false,
      env: "ACP_PROXY_SKILLS_MOUNTING_ENABLED",
    },
    skills_download_max_bytes: {
      doc: "Max bytes allowed for downloading a skills zip (0 disables)",
      format: "int",
      default: 200 * 1024 * 1024,
      env: "ACP_PROXY_SKILLS_DOWNLOAD_MAX_BYTES",
    },
    agent_env_allowlist: {
      doc: "Allowlist of env keys passed to agent (from init.env)",
      format: "string-array",
      default: [
        "USER_HOME",
        "HOME",
        "USER",
        "LOGNAME",
        "TUIXIU_BWRAP_USERNAME",
        "TUIXIU_BWRAP_UID",
        "TUIXIU_BWRAP_GID",
        "TUIXIU_BWRAP_HOME_PATH",
        "TUIXIU_PROJECT_ID",
        "TUIXIU_PROJECT_NAME",
        "TUIXIU_REPO_URL",
        "TUIXIU_SCM_TYPE",
        "TUIXIU_DEFAULT_BRANCH",
        "TUIXIU_BASE_BRANCH",
        "TUIXIU_RUN_ID",
        "TUIXIU_RUN_BRANCH",
        "TUIXIU_WORKSPACE",
        "TUIXIU_WORKSPACE_GUEST",
        "TUIXIU_PROJECT_HOME_DIR",
        "TUIXIU_WORKSPACE_MODE",
        "TUIXIU_SKIP_WORKSPACE_INIT",
        "TUIXIU_ROLE_KEY",
        "TUIXIU_GIT_AUTH_MODE",
        "TUIXIU_GIT_HTTP_USERNAME",
        "TUIXIU_GIT_HTTP_PASSWORD",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GITLAB_TOKEN",
        "GITLAB_ACCESS_TOKEN",
      ],
      env: "ACP_PROXY_AGENT_ENV_ALLOWLIST",
    },
    sandbox: {
      terminalEnabled: {
        doc: "Enable sandbox terminal",
        format: "boolean-ish",
        default: false,
        env: "ACP_PROXY_TERMINAL_ENABLED",
      },
      provider: {
        doc: "Sandbox provider",
        format: ["boxlite_oci", "container_oci", "host_process", "bwrap"],
        default: "container_oci",
        env: "ACP_PROXY_SANDBOX_PROVIDER",
      },
      image: {
        doc: "Sandbox image",
        format: "String",
        default: "",
        env: "ACP_PROXY_SANDBOX_IMAGE",
      },
      workingDir: {
        doc: "Working directory inside sandbox",
        format: "String",
        default: "",
        env: "ACP_PROXY_SANDBOX_WORKING_DIR",
      },
      volumes: {
        doc: "Sandbox volumes",
        format: "volumes-array",
        default: [],
        env: "ACP_PROXY_SANDBOX_VOLUMES",
      },
      env: {
        doc: "Sandbox environment variables",
        format: "string-record",
        default: {},
        env: "ACP_PROXY_SANDBOX_ENV",
      },
      cpus: {
        doc: "CPU limit",
        format: "number-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_CPUS",
      },
      memoryMib: {
        doc: "Memory limit (MiB)",
        format: "int-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_MEMORY_MIB",
      },
      workspaceMode: {
        doc: "Workspace mode",
        format: ["mount", "git_clone"],
        default: "mount",
        env: "ACP_PROXY_SANDBOX_WORKSPACE_MODE",
      },
      gitPush: {
        doc: "Enable git push from sandbox",
        format: "boolean-ish-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_GIT_PUSH",
      },
      workspaceHostRoot: {
        doc: "Workspace host root",
        format: "non-empty-string",
        default: defaultWorkspaceHostRoot,
        env: "ACP_PROXY_SANDBOX_WORKSPACE_HOST_ROOT",
      },
      runtime: {
        doc: "Container runtime",
        format: "String",
        default: "",
        env: "ACP_PROXY_SANDBOX_RUNTIME",
      },
      extraRunArgs: {
        doc: "Extra run args for container runtime",
        format: "string-array",
        default: [],
        env: "ACP_PROXY_SANDBOX_EXTRA_RUN_ARGS",
      },
      boxMode: {
        doc: "Box mode",
        format: "optional-enum",
        default: "",
        allowed: ["simple", "jsbox"],
        env: "ACP_PROXY_SANDBOX_BOX_MODE",
      },
      boxName: {
        doc: "Box name",
        format: "String",
        default: "",
        env: "ACP_PROXY_SANDBOX_BOX_NAME",
      },
      boxReuse: {
        doc: "Box reuse mode",
        format: "optional-enum",
        default: "",
        allowed: ["per_instance", "shared"],
        env: "ACP_PROXY_SANDBOX_BOX_REUSE",
      },
      boxAutoRemove: {
        doc: "Auto remove box",
        format: "boolean-ish-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_BOX_AUTO_REMOVE",
      },
      execTimeoutSeconds: {
        doc: "Exec timeout seconds",
        format: "int-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_EXEC_TIMEOUT_SECONDS",
      },
      execLogIntervalSeconds: {
        doc: "Exec log interval seconds",
        format: "int-or-null",
        default: null,
        env: "ACP_PROXY_SANDBOX_EXEC_LOG_INTERVAL_SECONDS",
      },
      bootstrap: {
        checkCommand: {
          doc: "Bootstrap check command",
          format: "string-array",
          default: [],
          env: "ACP_PROXY_SANDBOX_BOOTSTRAP_CHECK_COMMAND",
        },
        installCommand: {
          doc: "Bootstrap install command",
          format: "string-array",
          default: [],
          env: "ACP_PROXY_SANDBOX_BOOTSTRAP_INSTALL_COMMAND",
        },
        timeoutSeconds: {
          doc: "Bootstrap timeout seconds",
          format: "int-or-null",
          default: null,
          env: "ACP_PROXY_SANDBOX_BOOTSTRAP_TIMEOUT_SECONDS",
        },
      },
    },
    agent_command: {
      doc: "Agent command",
      format: "string-array",
      default: ["npx", "--yes", "@zed-industries/codex-acp"],
      env: "ACP_PROXY_AGENT_COMMAND",
    },
    agent: {
      id: {
        doc: "Agent id",
        format: "String",
        default: "",
        env: "ACP_PROXY_AGENT_ID",
      },
      name: {
        doc: "Agent name",
        format: "String",
        default: "",
        env: "ACP_PROXY_AGENT_NAME",
      },
      max_concurrent: {
        doc: "Max concurrent runs",
        format: "int",
        default: 1,
        env: "ACP_PROXY_AGENT_MAX_CONCURRENT",
      },
      capabilities: {
        doc: "Agent capabilities",
        format: "string-record",
        default: {},
        env: "ACP_PROXY_AGENT_CAPABILITIES",
      },
    },
  });
}

function applyRuntimeCompat() {
  const compat = process.env.ACP_PROXY_CONTAINER_RUNTIME?.trim();
  if (!compat) return;
  if (process.env.ACP_PROXY_SANDBOX_RUNTIME?.trim()) return;
  process.env.ACP_PROXY_SANDBOX_RUNTIME = compat;
}

function detectContainerRuntime(): string | null {
  for (const candidate of ["docker", "podman", "nerdctl"]) {
    const res = spawnSync(candidate, ["--version"], { stdio: "ignore", windowsHide: true });
    if (res.status === 0) return candidate;
  }
  return null;
}

function cleanOptionalFields(cfg: ProxyConfigRaw): ProxyConfig {
  const sandbox = { ...cfg.sandbox };
  const optionalKeys: Array<keyof SandboxConfig> = [
    "workingDir",
    "cpus",
    "memoryMib",
    "gitPush",
    "runtime",
    "extraRunArgs",
    "boxMode",
    "boxName",
    "boxReuse",
    "boxAutoRemove",
    "execTimeoutSeconds",
    "execLogIntervalSeconds",
  ];
  for (const key of optionalKeys) {
    const value = sandbox[key];
    if (value === null || value === "" || value === undefined) {
      delete sandbox[key];
    }
  }
  if (!sandbox.extraRunArgs?.length) delete sandbox.extraRunArgs;
  if (!sandbox.volumes?.length) delete sandbox.volumes;
  if (sandbox.env && !Object.keys(sandbox.env).length) delete sandbox.env;
  if (sandbox.provider === "host_process" && !sandbox.image?.trim()) {
    delete sandbox.image;
  }
  if (sandbox.bootstrap) {
    const bootstrap = { ...sandbox.bootstrap };
    if (!bootstrap.checkCommand?.length) delete bootstrap.checkCommand;
    if (!bootstrap.installCommand?.length) delete bootstrap.installCommand;
    if (bootstrap.timeoutSeconds === null || bootstrap.timeoutSeconds === undefined) {
      delete bootstrap.timeoutSeconds;
    }
    if (!Object.keys(bootstrap).length) delete sandbox.bootstrap;
    else sandbox.bootstrap = bootstrap;
  }

  const agent = { ...cfg.agent };
  if (!agent.name?.trim()) delete agent.name;
  if (agent.capabilities && !Object.keys(agent.capabilities as any).length) {
    delete agent.capabilities;
  }

  const cleaned: ProxyConfig = {
    ...cfg,
    sandbox: sandbox as SandboxConfig,
    agent: agent as AgentConfig,
  };
  if (!cleaned.register_url?.trim()) delete cleaned.register_url;
  if (!cleaned.bootstrap_token?.trim()) delete cleaned.bootstrap_token;
  if (!cleaned.auth_token?.trim()) delete cleaned.auth_token;
  return cleaned;
}

export async function loadConfig(
  configPath: string,
  opts?: { profile?: string },
): Promise<LoadedProxyConfig> {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  const raw = await readFile(abs, "utf8");
  const data = path.extname(abs).toLowerCase() === ".toml" ? parseToml(raw) : JSON.parse(raw);
  const record = ensureRecord(data);
  const base = { ...record } as RawProxyConfig;
  const profiles = ensureRecord(base.profiles) as Record<string, ProxyConfigOverride>;
  delete (base as Partial<RawProxyConfig>).profiles;

  const profile = opts?.profile?.trim() ? opts.profile.trim() : null;
  const override = profile ? profiles?.[profile] ?? null : null;
  if (profile && !override) throw new Error(`未找到配置 profile: ${profile}`);

  const merged = override ? mergeConfig(base as ProxyConfig, override) : (base as ProxyConfig);

  applyRuntimeCompat();
  const schema = buildSchema();
  schema.load(merged);
  schema.validate({ allowed: "warn" });

  const effective = cleanOptionalFields(normalizeConfig(schema.getProperties() as ProxyConfigRaw));
  if (
    effective.sandbox.provider === "host_process" &&
    effective.sandbox.workspaceMode === "git_clone"
  ) {
    throw new Error("sandbox.provider=host_process 不支持 workspaceMode=git_clone");
  }

  const sandboxProvider = effective.sandbox.provider;
  let runtime = effective.sandbox.runtime?.trim() ? effective.sandbox.runtime.trim() : "";
  if (sandboxProvider === "container_oci" && !runtime) {
    const detected = detectContainerRuntime();
    if (!detected) {
      throw new Error(
        "sandbox.provider=container_oci 且未配置 sandbox.runtime，且未探测到 docker/podman/nerdctl；请配置 sandbox.runtime 或安装其中之一",
      );
    }
    runtime = detected;
  }

  let image = effective.sandbox.image?.trim() ? effective.sandbox.image.trim() : "";
  if (sandboxProvider !== "host_process" && !image) {
    image = "tuixiu-codex-acp:local";
  }

  const agentId = String(effective.agent.id ?? "").trim() || (await loadOrCreateAgentId());
  const agentName = effective.agent.name?.trim() ? effective.agent.name.trim() : agentId;

  return {
    ...effective,
    sandbox: {
      ...effective.sandbox,
      ...(sandboxProvider === "container_oci" ? { runtime } : {}),
      ...(image ? { image } : {}),
    },
    agent: {
      ...effective.agent,
      id: agentId,
      name: agentName,
      capabilities: effective.agent.capabilities ?? {},
    },
  };
}
