import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import * as github from "../integrations/github.js";
import { uuidv7 } from "../utils/uuid.js";

function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const key = name.toLowerCase();
  const v = (headers as any)[key] as unknown;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (!label || typeof label !== "object") return null;
      const name = (label as any).name;
      return typeof name === "string" ? name.trim() : null;
    })
    .filter((x): x is string => Boolean(x));
}

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyGitHubSignature(opts: { secret: string; rawBody: Buffer; signature256?: string }): boolean {
  const sig = (opts.signature256 ?? "").trim();
  if (!sig.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")}`;
  return safeTimingEqual(expected, sig);
}

function toRepoKey(parsed: github.ParsedGitHubRepo): string {
  return `${parsed.host.toLowerCase()}/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

export function makeGitHubWebhookRoutes(deps: {
  prisma: PrismaDeps;
  webhookSecret?: string;
  parseRepo?: typeof github.parseGitHubRepo;
  onIssueUpserted?: (issueId: string, reason: string) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const parseRepo = deps.parseRepo ?? github.parseGitHubRepo;
    const webhookSecret = typeof deps.webhookSecret === "string" && deps.webhookSecret.trim() ? deps.webhookSecret.trim() : null;

    server.post(
      "/github",
      {
        // GitHub webhook 签名校验需要原始 body
        preParsing: (request: any, _reply: any, payload: any, done: any) => {
          const chunks: Buffer[] = [];
          payload.on("data", (chunk: Buffer) => chunks.push(chunk));
          payload.on("end", () => {
            const rawBody = Buffer.concat(chunks);
            request.rawBody = rawBody;
            done(null, Readable.from([rawBody]));
          });
          payload.on("error", (err: unknown) => done(err));
        }
      },
      async (request) => {
        const event = getHeader(request.headers as any, "x-github-event") ?? "";
        const signature256 = getHeader(request.headers as any, "x-hub-signature-256");

        const rawBody = (request as any).rawBody as Buffer | undefined;
        if (webhookSecret) {
          if (!rawBody || !Buffer.isBuffer(rawBody)) {
            return { success: false, error: { code: "NO_RAW_BODY", message: "无法读取 webhook 原始 body" } };
          }
          if (!verifyGitHubSignature({ secret: webhookSecret, rawBody, signature256 })) {
            return { success: false, error: { code: "BAD_SIGNATURE", message: "GitHub webhook 签名校验失败" } };
          }
        }

        if (event === "ping") {
          return { success: true, data: { ok: true, event: "ping" } };
        }

        if (event !== "issues") {
          return { success: true, data: { ok: true, ignored: true, reason: "UNSUPPORTED_EVENT", event } };
        }

        const bodySchema = z.object({
          action: z.string().min(1),
          issue: z
            .object({
              id: z.union([z.number(), z.string()]),
              number: z.number().int().positive(),
              title: z.string().min(1),
              body: z.string().nullable().optional(),
              state: z.string().optional(),
              html_url: z.string().min(1),
              labels: z.array(z.any()).optional(),
              pull_request: z.any().optional()
            }),
          repository: z
            .object({
              html_url: z.string().min(1)
            })
        });

        let payload: z.infer<typeof bodySchema>;
        try {
          payload = bodySchema.parse(request.body ?? {});
        } catch (err) {
          return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
        }

        if (payload.issue.pull_request) {
          return { success: true, data: { ok: true, ignored: true, reason: "IS_PULL_REQUEST" } };
        }

        const repoParsed = parseRepo(payload.repository.html_url);
        if (!repoParsed) {
          return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook repoUrl 解析 GitHub owner/repo" } };
        }
        const repoKey = toRepoKey(repoParsed);

        const projects = await deps.prisma.project.findMany();
        const project =
          (projects as any[]).find((p) => {
            const pr = typeof p?.repoUrl === "string" ? parseRepo(p.repoUrl) : null;
            return pr ? toRepoKey(pr) === repoKey : false;
          }) ?? null;

        if (!project) {
          return {
            success: false,
            error: { code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project", details: repoParsed.webBaseUrl }
          };
        }

        const externalId = String(payload.issue.id);
        const existing = await deps.prisma.issue.findFirst({
          where: { projectId: project.id, externalProvider: "github", externalId }
        });

        const externalState = typeof payload.issue.state === "string" ? payload.issue.state : "";
        const externalLabels = normalizeGitHubLabels(payload.issue.labels);
        const lastSyncedAt = new Date();

        const shouldCreate = payload.action === "opened" || payload.action === "reopened";
        if (!existing && !shouldCreate) {
          return { success: true, data: { ok: true, ignored: true, reason: "NOT_OPEN_ACTION", action: payload.action } };
        }

        if (existing) {
          const nextStatus =
            payload.action === "reopened" && ["done", "failed", "cancelled"].includes((existing as any).status)
              ? "pending"
              : undefined;

          const updated = await deps.prisma.issue.update({
            where: { id: (existing as any).id },
            data: {
              title: payload.issue.title,
              description: payload.issue.body ?? null,
              ...(nextStatus ? { status: nextStatus as any } : null),
              externalNumber: payload.issue.number,
              externalUrl: payload.issue.html_url,
              externalState,
              externalLabels,
              lastSyncedAt
            } as any
          });

          deps.onIssueUpserted?.((updated as any).id, `github_webhook:${payload.action}`);
          return { success: true, data: { ok: true, projectId: project.id, issueId: (updated as any).id, created: false } };
        }

        try {
          const created = await deps.prisma.issue.create({
            data: {
              id: uuidv7(),
              projectId: project.id,
              title: payload.issue.title,
              description: payload.issue.body ?? null,
              status: "pending",
              externalProvider: "github",
              externalId,
              externalNumber: payload.issue.number,
              externalUrl: payload.issue.html_url,
              externalState,
              externalLabels,
              lastSyncedAt,
              createdBy: "github_webhook"
            } as any
          });

          deps.onIssueUpserted?.((created as any).id, `github_webhook:${payload.action}`);
          return { success: true, data: { ok: true, projectId: project.id, issueId: (created as any).id, created: true } };
        } catch (err) {
          const again = await deps.prisma.issue.findFirst({
            where: { projectId: project.id, externalProvider: "github", externalId }
          });
          if (again) {
            deps.onIssueUpserted?.((again as any).id, `github_webhook:${payload.action}`);
            return { success: true, data: { ok: true, projectId: project.id, issueId: (again as any).id, created: false } };
          }
          return { success: false, error: { code: "CREATE_FAILED", message: "写入 Issue 失败", details: String(err) } };
        }
      }
    );
  };
}
