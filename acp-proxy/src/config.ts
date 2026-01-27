import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  max_concurrent: z.coerce.number().int().positive().default(1),
  capabilities: z.unknown().optional(),
});

const boxliteVolumeSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    if (
      typeof obj.source === "string" &&
      typeof obj.target === "string" &&
      typeof obj.hostPath !== "string" &&
      typeof obj.guestPath !== "string"
    ) {
      return { hostPath: obj.source, guestPath: obj.target, readOnly: obj.readOnly };
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
    provider: z.enum(["host_process", "boxlite_oci"]).default("host_process"),
    boxlite: z
      .object({
        image: z.string().min(1).optional(),
        workingDir: z.string().min(1).optional(),
        workspaceMode: z.enum(["mount", "git_clone"]).default("mount"),
        volumes: z
          .array(boxliteVolumeSchema)
          .optional(),
        env: z.record(z.string()).optional(),
        cpus: z.coerce.number().positive().optional(),
        memoryMib: z.coerce.number().int().positive().optional(),
      })
      .optional(),
  })
  .default({ provider: "host_process" });

const pathMappingSchema = z
  .object({
    type: z.literal("windows_to_wsl"),
    wslMountRoot: z.string().min(1).default("/mnt"),
  })
  .optional();

const configSchema = z
  .object({
    orchestrator_url: z.string().min(1),
    auth_token: z.string().optional(),
    cwd: z.string().min(1).optional(),
    pathMapping: pathMappingSchema,
    heartbeat_seconds: z.coerce.number().int().positive().default(30),
    mock_mode: z.boolean().default(false),
    sandbox: sandboxSchema,
    agent_command: z.array(z.string().min(1)).default(["npx", "--yes", "@zed-industries/codex-acp"]),
    agent: agentSchema,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.sandbox.provider !== "boxlite_oci") return;

    const boxlite = cfg.sandbox.boxlite;
    if (!boxlite) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sandbox", "boxlite"],
        message: "sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite",
      });
      return;
    }

    if (!String(boxlite.image ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sandbox", "boxlite", "image"],
        message: "sandbox.provider=boxlite_oci 时必须配置 sandbox.boxlite.image",
      });
    }

    const mode = boxlite.workspaceMode ?? "mount";
    if (mode === "mount") {
      const volumes = boxlite.volumes ?? [];
      if (!Array.isArray(volumes) || volumes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sandbox", "boxlite", "volumes"],
          message:
            "BoxLite mount 模式必须配置 sandbox.boxlite.volumes（至少挂载一个包含 Run workspace 的目录）。若不想挂载请改用 sandbox.boxlite.workspaceMode=git_clone。",
        });
      }
    }
  });

export type ProxyConfig = z.infer<typeof configSchema>;

export type LoadedProxyConfig = Omit<ProxyConfig, "cwd" | "agent"> & {
  cwd: string;
  agent: Omit<ProxyConfig["agent"], "name" | "capabilities"> & {
    name: string;
    capabilities: unknown;
  };
};

export async function loadConfig(configPath: string): Promise<LoadedProxyConfig> {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(process.cwd(), configPath);
  const raw = await readFile(abs, "utf8");
  const parsed = configSchema.parse(JSON.parse(raw));
  const cwd = parsed.cwd?.trim() ? parsed.cwd.trim() : process.cwd();
  return {
    ...parsed,
    cwd,
    agent: {
      ...parsed.agent,
      name: parsed.agent.name?.trim() ? parsed.agent.name.trim() : parsed.agent.id,
      capabilities: parsed.agent.capabilities ?? {},
    },
  };
}
