import { z } from "zod";
import os from "node:os";
import path from "node:path";

const defaultWorkspacesRoot = path.join(os.homedir(), ".tuixiu", "workspaces");
const defaultRepoCacheRoot = path.join(os.homedir(), ".tuixiu", "repo-cache");
const defaultAttachmentsRoot = path.join(os.homedir(), ".tuixiu", "attachments");
const defaultSkillPackagesRoot = path.join(os.homedir(), ".tuixiu", "skill-packages");

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
  JWT_SECRET: z.string().min(1).default("dev-jwt-secret"),
  BOOTSTRAP_ADMIN_USERNAME: z.string().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  WORKSPACES_ROOT: pathWithDefault(defaultWorkspacesRoot),
  REPO_CACHE_ROOT: pathWithDefault(defaultRepoCacheRoot),
  WORKSPACE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  REPO_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60 * 60),
  ATTACHMENTS_ROOT: pathWithDefault(defaultAttachmentsRoot),
  ATTACHMENTS_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  SKILL_PACKAGES_ROOT: pathWithDefault(defaultSkillPackagesRoot),
  SKILL_PACKAGES_MAX_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  SKILLS_CLI_NPX_PACKAGE: z.string().min(1).default("skills@latest"),
  SKILLS_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  GITLAB_URL: z.string().optional(),
  GITLAB_ACCESS_TOKEN: z.string().optional(),
  GITLAB_PROJECT_ID: z.string().optional(),
  GITLAB_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  CODEUP_WEBHOOK_SECRET: z.string().optional(),
  MESSAGE_WEBHOOK_SECRET: z.string().optional(),
  COOKIE_SECURE: z.string().optional(),
  ACP_PROXY_BOOTSTRAP_TOKEN: z.string().optional(),

  PM_AUTOMATION_ENABLED: z.string().optional(),
  PM_LLM_BASE_URL: z.string().optional(),
  PM_LLM_MODEL: z.string().optional(),
  PM_LLM_API_KEY: z.string().optional(),
  PM_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional()
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${parsed.error.message}`);
  }
  return parsed.data;
}
