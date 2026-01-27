import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { advanceTaskFromRunTerminal } from "../services/taskProgress.js";

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

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeRepoPath(rawPath: string): string {
  let p = rawPath.trim();
  if (p.startsWith("/")) p = p.slice(1);
  p = p.replace(/\/+$/g, "");
  if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
  return p;
}

function toRepoKey(raw: string): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  const lower = input.toLowerCase();
  try {
    if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("ssh://")) {
      const u = new URL(input);
      const host = u.hostname.trim().toLowerCase();
      const path = normalizeRepoPath(u.pathname);
      if (!host || !path) return null;
      return `${host}/${path.toLowerCase()}`;
    }
  } catch {
    // fallthrough
  }

  // scp-like: user@host:namespace/repo.git (Codeup 的 ssh 例子常见)
  const m = input.match(/^(?:.+@)?([^:]+):(.+)$/);
  if (m) {
    const host = String(m[1] ?? "").trim().toLowerCase();
    const path = normalizeRepoPath(String(m[2] ?? ""));
    if (!host || !path) return null;
    return `${host}/${path.toLowerCase()}`;
  }

  return null;
}

function extractRepoUrlFromPayload(payload: any): string | null {
  const repo = payload?.repository;
  if (repo && typeof repo === "object") {
    if (typeof repo.git_http_url === "string" && repo.git_http_url.trim()) return repo.git_http_url.trim();
    if (typeof repo.url === "string" && repo.url.trim()) return repo.url.trim();
    if (typeof repo.homepage === "string" && repo.homepage.trim()) return repo.homepage.trim();
  }

  const attrs = payload?.object_attributes;
  if (attrs && typeof attrs === "object") {
    const source = (attrs as any).source;
    if (source && typeof source === "object") {
      if (typeof source.http_url === "string" && source.http_url.trim()) return source.http_url.trim();
      if (typeof source.web_url === "string" && source.web_url.trim()) return source.web_url.trim();
    }
    const target = (attrs as any).target;
    if (target && typeof target === "object") {
      if (typeof target.http_url === "string" && target.http_url.trim()) return target.http_url.trim();
      if (typeof target.web_url === "string" && target.web_url.trim()) return target.web_url.trim();
    }
  }

  return null;
}

const baseSchema = z
  .object({
    object_kind: z.string().optional(),
    repository: z.any().optional(),
    object_attributes: z.any().optional(),
  })
  .passthrough();

const mergeRequestSchema = z
  .object({
    object_kind: z.literal("merge_request").optional(),
    version: z.string().optional(),
    repository: z
      .object({
        git_http_url: z.string().optional(),
        url: z.string().optional(),
        homepage: z.string().optional(),
      })
      .optional(),
    object_attributes: z
      .object({
        source_branch: z.string().min(1),
        target_branch: z.string().min(1).optional(),
        state: z.string().optional(),
        action: z.string().optional(),
        url: z.string().min(1).optional(),
        iid: z.number().int().positive().optional(),
        local_id: z.number().int().positive().optional(),
        project_id: z.number().int().positive().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function makeCodeupWebhookRoutes(deps: {
  prisma: PrismaDeps;
  webhookSecret?: string;
  broadcastToClients?: (payload: unknown) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const globalSecret =
      typeof deps.webhookSecret === "string" && deps.webhookSecret.trim() ? deps.webhookSecret.trim() : null;

    server.post("/codeup", async (request) => {
      const eventHeader = getHeader(request.headers as any, "codeup-event") ?? "";
      const tokenHeader = getHeader(request.headers as any, "x-codeup-token") ?? "";

      let base: z.infer<typeof baseSchema>;
      try {
        base = baseSchema.parse(request.body ?? {});
      } catch (err) {
        return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
      }

      const kindFromBody = typeof base.object_kind === "string" ? base.object_kind.trim().toLowerCase() : "";
      const kind =
        kindFromBody ||
        (eventHeader.toLowerCase().includes("merge request") ? "merge_request" : "") ||
        (eventHeader.toLowerCase().includes("tag push") ? "tag_push" : "") ||
        (eventHeader.toLowerCase().includes("push") ? "push" : "") ||
        (eventHeader.toLowerCase().includes("note") ? "note" : "");

      const repoUrl = extractRepoUrlFromPayload(base);
      const repoKey = repoUrl ? toRepoKey(repoUrl) : null;
      if (!repoKey) {
        return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook payload 解析仓库地址" } };
      }

      const projects = await deps.prisma.project.findMany();
      const project =
        (projects as any[]).find((p) => {
          const k = typeof p?.repoUrl === "string" ? toRepoKey(p.repoUrl) : null;
          return k ? k === repoKey : false;
        }) ?? null;

      if (!project) {
        return { success: false, error: { code: "NO_PROJECT", message: "未找到与该 Codeup 仓库匹配的 Project" } };
      }

      const effectiveSecret = String(globalSecret ?? "").trim();
      if (effectiveSecret) {
        if (!tokenHeader || !safeTimingEqual(tokenHeader, effectiveSecret)) {
          return { success: false, error: { code: "BAD_TOKEN", message: "Codeup webhook token 校验失败" } };
        }
      }

      if (kind !== "merge_request") {
        return { success: true, data: { ok: true, ignored: true, reason: "UNSUPPORTED_KIND", kind, event: eventHeader } };
      }

      let payload: z.infer<typeof mergeRequestSchema>;
      try {
        payload = mergeRequestSchema.parse(base);
      } catch (err) {
        return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
      }

      const action = String(payload.object_attributes.action ?? "").trim().toLowerCase();
      const state = String(payload.object_attributes.state ?? "").trim().toLowerCase();
      const merged = state === "merged" || action === "merge";
      if (!merged) {
        return { success: true, data: { ok: true, handled: true, merged: false } };
      }

      const sourceBranch = payload.object_attributes.source_branch;

      const runs = await deps.prisma.run.findMany({
        where: {
          status: "running",
          executorType: "human",
          branchName: sourceBranch,
          issue: { is: { projectId: (project as any).id } } as any,
          step: { is: { kind: "pr.merge" } } as any,
        } as any,
        select: { id: true, issueId: true, taskId: true, stepId: true },
      });

      let updatedCount = 0;
      for (const run of runs as any[]) {
        await deps.prisma.run
          .update({
            where: { id: run.id },
            data: { status: "completed", completedAt: new Date() } as any,
          })
          .then(() => {
            updatedCount += 1;
          })
          .catch(() => {});

        await advanceTaskFromRunTerminal({ prisma: deps.prisma }, run.id, "completed").catch(() => {});
        if ((run as any).taskId) {
          deps.broadcastToClients?.({
            type: "task_updated",
            issue_id: run.issueId,
            task_id: run.taskId,
            step_id: run.stepId ?? undefined,
            run_id: run.id,
            reason: "codeup_merge_request_merged",
          });
        }
      }

      return { success: true, data: { ok: true, handled: true, merged: true, runsUpdated: updatedCount } };
    });
  };
}

