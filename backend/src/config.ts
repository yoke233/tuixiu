import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.string().min(1).default("info"),
  GITLAB_URL: z.string().optional(),
  GITLAB_ACCESS_TOKEN: z.string().optional(),
  GITLAB_PROJECT_ID: z.string().optional(),
  GITLAB_WEBHOOK_SECRET: z.string().optional()
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`环境变量校验失败: ${parsed.error.message}`);
  }
  return parsed.data;
}

