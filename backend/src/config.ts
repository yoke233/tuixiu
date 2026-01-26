import { z } from "zod";
import os from "node:os";
import path from "node:path";

const defaultWorkspacesRoot = path.join(os.homedir(), ".tuixiu", "workspaces");
const defaultRepoCacheRoot = path.join(os.homedir(), ".tuixiu", "repo-cache");

function pathWithDefault(defaultValue: string) {
  return z.preprocess((v) => {
    if (typeof v !== "string") return defaultValue;
    const trimmed = v.trim();
    return trimmed ? trimmed : defaultValue;
  }, z.string().min(1));
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.string().min(1).default("info"),
  WORKSPACES_ROOT: pathWithDefault(defaultWorkspacesRoot),
  REPO_CACHE_ROOT: pathWithDefault(defaultRepoCacheRoot),
  WORKSPACE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REPO_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  GITLAB_URL: z.string().optional(),
  GITLAB_ACCESS_TOKEN: z.string().optional(),
  GITLAB_PROJECT_ID: z.string().optional(),
  GITLAB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${parsed.error.message}`);
  }
  return parsed.data;
}
