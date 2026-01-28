import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  max_concurrent: z.coerce.number().int().positive().default(1),
  capabilities: z.unknown().optional(),
});

const volumeSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    if (
      typeof obj.source === "string" &&
      typeof obj.target === "string" &&
      typeof obj.hostPath !== "string" &&
      typeof obj.guestPath !== "string"
    ) {
      return {
        hostPath: obj.source,
        guestPath: obj.target,
        readOnly: obj.readOnly,
      };
    }
    return v;
  },
  z.object({
    hostPath: z.string().min(1),
    guestPath: z.string().min(1),
    readOnly: z.boolean().optional(),
  }),
);

const sandboxSchema = z
  .object({
    terminalEnabled: z.boolean().default(false),
    provider: z.enum(["boxlite_oci", "container_oci"]),
    image: z.string().min(1),
    workingDir: z.string().min(1).optional(),
    volumes: z.array(volumeSchema).optional(),
    env: z.record(z.string()).optional(),
    cpus: z.coerce.number().positive().optional(),
    memoryMib: z.coerce.number().int().positive().optional(),
    workspaceMode: z.enum(["mount"]).default("mount"),
    runtime: z.string().min(1).optional(),
    extraRunArgs: z.array(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.provider === "container_oci" && !v.runtime?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sandbox.provider=container_oci 时必须配置 sandbox.runtime",
      });
    }
  });

const pathMappingSchema = z
  .object({
    type: z.literal("windows_to_wsl"),
    wslMountRoot: z.string().min(1).default("/mnt"),
  })
  .optional();

const configCoreSchema = z.object({
  orchestrator_url: z.string().min(1),
  auth_token: z.string().optional(),
  cwd: z.string().min(1).optional(),
  pathMapping: pathMappingSchema,
  heartbeat_seconds: z.coerce.number().int().positive().default(30),
  mock_mode: z.boolean().default(false),
  sandbox: sandboxSchema,
  agent_command: z
    .array(z.string().min(1))
    .default(["npx", "--yes", "@zed-industries/codex-acp"]),
  agent: agentSchema,
});

const configOverrideSchema = z.object({
  orchestrator_url: z.string().min(1).optional(),
  auth_token: z.string().optional(),
  cwd: z.string().min(1).optional(),
  pathMapping: pathMappingSchema.optional(),
  heartbeat_seconds: z.coerce.number().int().positive().optional(),
  mock_mode: z.boolean().optional(),
  sandbox: z
    .object({
      terminalEnabled: z.boolean().optional(),
      provider: z.enum(["boxlite_oci", "container_oci"]).optional(),
      image: z.string().min(1).optional(),
      workingDir: z.string().min(1).optional(),
      volumes: z.array(volumeSchema).optional(),
      env: z.record(z.string()).optional(),
      cpus: z.coerce.number().positive().optional(),
      memoryMib: z.coerce.number().int().positive().optional(),
      workspaceMode: z.enum(["mount"]).optional(),
      runtime: z.string().min(1).optional(),
      extraRunArgs: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  agent_command: z.array(z.string().min(1)).optional(),
  agent: agentSchema.partial().optional(),
});

const configSchema = configCoreSchema.extend({
  profiles: z.record(z.string().min(1), configOverrideSchema).optional(),
});

export type ProxyConfig = z.infer<typeof configSchema>;

export type LoadedProxyConfig = Omit<ProxyConfig, "cwd" | "agent"> & {
  cwd: string;
  agent: Omit<ProxyConfig["agent"], "name" | "capabilities"> & {
    name: string;
    capabilities: unknown;
  };
};

function mergeSandbox(
  base: ProxyConfig["sandbox"],
  override: Partial<ProxyConfig["sandbox"]>,
): ProxyConfig["sandbox"] {
  return { ...base, ...override };
}

function mergeConfig(
  base: ProxyConfig,
  override: Partial<ProxyConfig>,
): ProxyConfig {
  const merged: any = { ...base, ...override };
  if (override.sandbox)
    merged.sandbox = mergeSandbox(base.sandbox, override.sandbox as any);
  if (override.agent) merged.agent = { ...base.agent, ...override.agent };
  return merged;
}

export async function loadConfig(
  configPath: string,
  opts?: { profile?: string },
): Promise<LoadedProxyConfig> {
  const abs = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  const raw = await readFile(abs, "utf8");
  const data =
    path.extname(abs).toLowerCase() === ".toml"
      ? parseToml(raw)
      : JSON.parse(raw);
  const parsed = configSchema.parse(data);

  const profile = opts?.profile?.trim() ? opts.profile.trim() : null;
  const override = profile ? (parsed.profiles?.[profile] ?? null) : null;
  if (profile && !override) throw new Error(`未找到配置 profile: ${profile}`);

  const merged = override ? mergeConfig(parsed, override as any) : parsed;
  const envOverride: Partial<ProxyConfig> = {};
  const envSandboxOverride: Partial<ProxyConfig["sandbox"]> = {};
  if (process.env.ACP_PROXY_ORCHESTRATOR_URL?.trim()) {
    envOverride.orchestrator_url =
      process.env.ACP_PROXY_ORCHESTRATOR_URL.trim();
  }
  if (process.env.ACP_PROXY_AUTH_TOKEN?.trim()) {
    envOverride.auth_token = process.env.ACP_PROXY_AUTH_TOKEN.trim();
  }
  if (process.env.ACP_PROXY_CWD?.trim()) {
    envOverride.cwd = process.env.ACP_PROXY_CWD.trim();
  }
  const terminalEnabledRaw = process.env.ACP_PROXY_TERMINAL_ENABLED?.trim();
  if (terminalEnabledRaw) {
    const enabled =
      terminalEnabledRaw === "1" || terminalEnabledRaw.toLowerCase() === "true";
    envSandboxOverride.terminalEnabled = enabled;
  }
  if (process.env.ACP_PROXY_SANDBOX_PROVIDER?.trim()) {
    const raw = process.env.ACP_PROXY_SANDBOX_PROVIDER.trim();
    if (raw === "boxlite_oci" || raw === "container_oci")
      envSandboxOverride.provider = raw;
  }
  if (process.env.ACP_PROXY_SANDBOX_IMAGE?.trim()) {
    envSandboxOverride.image = process.env.ACP_PROXY_SANDBOX_IMAGE.trim();
  }
  if (process.env.ACP_PROXY_SANDBOX_WORKING_DIR?.trim()) {
    envSandboxOverride.workingDir =
      process.env.ACP_PROXY_SANDBOX_WORKING_DIR.trim();
  }
  if (process.env.ACP_PROXY_CONTAINER_RUNTIME?.trim()) {
    envSandboxOverride.runtime = process.env.ACP_PROXY_CONTAINER_RUNTIME.trim();
  }
  if (Object.keys(envSandboxOverride).length) {
    envOverride.sandbox = envSandboxOverride as any;
  }

  const effective = configCoreSchema.parse(
    Object.keys(envOverride).length
      ? mergeConfig(merged, envOverride as any)
      : merged,
  );
  const cwd = effective.cwd?.trim() ? effective.cwd.trim() : process.cwd();
  return {
    ...effective,
    cwd,
    agent: {
      ...effective.agent,
      name: effective.agent.name?.trim()
        ? effective.agent.name.trim()
        : effective.agent.id,
      capabilities: effective.agent.capabilities ?? {},
    },
  };
}
