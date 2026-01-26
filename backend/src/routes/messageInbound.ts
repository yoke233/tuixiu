import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
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

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = String(item ?? "").trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function makeMessageInboundRoutes(deps: {
  prisma: PrismaDeps;
  webhookSecret?: string;
  onIssueUpserted?: (issueId: string, reason: string) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const webhookSecret =
      typeof deps.webhookSecret === "string" && deps.webhookSecret.trim() ? deps.webhookSecret.trim() : null;

    server.post("/messages/inbound", async (request) => {
      if (webhookSecret) {
        const token =
          getHeader(request.headers as any, "x-webhook-token") ??
          getHeader(request.headers as any, "x-message-token") ??
          (() => {
            const auth = getHeader(request.headers as any, "authorization") ?? "";
            const m = auth.match(/^Bearer\s+(.+)$/i);
            return m ? m[1] : null;
          })();

        const actual = String(token ?? "").trim();
        if (!actual || !safeTimingEqual(actual, webhookSecret)) {
          return { success: false, error: { code: "BAD_TOKEN", message: "消息入口 token 校验失败" } };
        }
      }

      const bodySchema = z.object({
        projectId: z.string().uuid().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        testRequirements: z.string().optional(),
        externalId: z.string().min(1).optional(),
        externalUrl: z.string().min(1).optional(),
        labels: z.array(z.string()).optional(),
        createdBy: z.string().min(1).max(100).optional(),
      });

      const body = bodySchema.parse(request.body ?? {});

      const project = body.projectId
        ? await deps.prisma.project.findUnique({ where: { id: body.projectId } })
        : await deps.prisma.project.findFirst({ orderBy: { createdAt: "desc" } });
      if (!project) {
        return { success: false, error: { code: "NO_PROJECT", message: "请先创建 Project" } };
      }

      const externalId = body.externalId?.trim() ?? "";
      if (externalId) {
        const existing = await deps.prisma.issue.findFirst({
          where: { projectId: (project as any).id, externalProvider: "message", externalId },
          include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
        });
        if (existing) {
          const updated = await deps.prisma.issue.update({
            where: { id: (existing as any).id },
            data: {
              title: body.title,
              description: body.description ?? null,
              acceptanceCriteria: body.acceptanceCriteria ?? (existing as any).acceptanceCriteria,
              constraints: body.constraints ?? (existing as any).constraints,
              testRequirements: body.testRequirements ?? (existing as any).testRequirements,
              externalUrl: body.externalUrl ?? (existing as any).externalUrl,
              externalLabels: normalizeStringList(body.labels, 50),
              lastSyncedAt: new Date(),
              status:
                ["done", "failed", "cancelled"].includes(String((existing as any).status ?? "")) ? ("pending" as any) : undefined,
            } as any,
          });

          deps.onIssueUpserted?.((updated as any).id, "message_inbound");
          return { success: true, data: { issue: updated, created: false } };
        }
      }

      const created = await deps.prisma.issue.create({
        data: {
          id: uuidv7(),
          projectId: (project as any).id,
          title: body.title,
          description: body.description ?? null,
          acceptanceCriteria: body.acceptanceCriteria ?? [],
          constraints: body.constraints ?? [],
          testRequirements: body.testRequirements,
          status: "pending",
          externalProvider: externalId ? "message" : null,
          externalId: externalId || null,
          externalUrl: body.externalUrl ?? null,
          externalLabels: normalizeStringList(body.labels, 50),
          lastSyncedAt: new Date(),
          createdBy: body.createdBy ?? "message_inbound",
        } as any,
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
      });

      deps.onIssueUpserted?.((created as any).id, "message_inbound");
      return { success: true, data: { issue: created, created: true } };
    });
  };
}

