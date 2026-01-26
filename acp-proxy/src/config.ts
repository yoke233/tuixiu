import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  max_concurrent: z.coerce.number().int().positive().default(1),
  capabilities: z.unknown().optional(),
});

const configSchema = z.object({
  orchestrator_url: z.string().min(1),
  auth_token: z.string().optional(),
  cwd: z.string().min(1).optional(),
  heartbeat_seconds: z.coerce.number().int().positive().default(30),
  mock_mode: z.boolean().default(false),
  agent_command: z.array(z.string().min(1)).default(["npx", "--yes", "@zed-industries/codex-acp"]),
  agent: agentSchema,
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
