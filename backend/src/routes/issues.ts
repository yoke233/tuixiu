import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../db.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import { startIssueRun, type CreateWorkspaceResult } from "../modules/runs/startIssueRun.js";
import { uuidv7 } from "../utils/uuid.js";
import { toPublicProject } from "../utils/publicProject.js";

function toPublicIssue<T extends { project?: unknown }>(issue: T): T {
  const anyIssue = issue as any;
  if (anyIssue && anyIssue.project) {
    return { ...anyIssue, project: toPublicProject(anyIssue.project) };
  }
  return issue;
}

function hasSessionLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  return labels.some((label) => typeof label === "string" && label.trim().toLowerCase() === "_session");
}

const issueStatusSchema = z.enum([
  "pending",
  "running",
  "reviewing",
  "done",
  "failed",
  "cancelled"
]);

const mutableIssueStatusSchema = z.enum(["pending", "reviewing", "done", "failed", "cancelled"]);

const archivedQuerySchema = z.preprocess((v) => {
  if (typeof v === "string") {
    const raw = v.trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
  }
  return v;
}, z.boolean().optional());

const createIssueBodySchema = z.object({
  projectId: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  testRequirements: z.string().optional()
});

export function makeIssueRoutes(deps: {
  prisma: PrismaDeps;
  acp: AcpTunnel;
  broadcastToClients?: (payload: unknown) => void;
  createWorkspace?: (opts: {
    runId: string;
    baseBranch: string;
    name: string;
  }) => Promise<CreateWorkspaceResult>;
  onIssueCreated?: (issueId: string, reason: string) => void;
}): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async (request) => {
      const querySchema = z.object({
        status: issueStatusSchema.optional(),
        statuses: z.string().optional(),
        archived: archivedQuerySchema,
        projectId: z.string().uuid().optional(),
        q: z.string().trim().min(1).max(200).optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0)
      });
      const { status, statuses, archived, projectId, q, limit, offset } = querySchema.parse(request.query);

      let statusList: Array<z.infer<typeof issueStatusSchema>> | null = null;
      if (typeof statuses === "string") {
        const parts = statuses
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (parts.length) statusList = z.array(issueStatusSchema).parse(parts);
      }

      const where: any = {};
      if (projectId) where.projectId = projectId;
      if (statusList) where.status = { in: statusList };
      else if (status) where.status = status;
      if (typeof archived === "boolean") where.archivedAt = archived ? { not: null } : null;
      if (q) where.title = { contains: q, mode: "insensitive" };
      const [total, issues] = await Promise.all([
        deps.prisma.issue.count({ where }),
        deps.prisma.issue.findMany({
          where,
          include: { project: true, runs: { orderBy: { createdAt: "desc" } } },
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset
        })
      ]);

      return {
        success: true,
        data: { issues: issues.map((i: any) => toPublicIssue(i)), total, limit, offset }
      };
    });

    server.get("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const issue = await deps.prisma.issue.findUnique({
        where: { id },
        include: { project: true, runs: { orderBy: { createdAt: "desc" } } }
      });
      if (!issue) {
        return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
      }
      return { success: true, data: { issue: toPublicIssue(issue as any) } };
    });

    server.post("/", async (request) => {
      const body = createIssueBodySchema.parse(request.body);

      const project = body.projectId
        ? await deps.prisma.project.findUnique({ where: { id: body.projectId } })
        : await deps.prisma.project.findFirst({ orderBy: { createdAt: "desc" } });

      if (!project) {
        return { success: false, error: { code: "NO_PROJECT", message: "请先创建 Project" } };
      }

      const issue = await deps.prisma.issue.create({
        data: {
          id: uuidv7(),
          projectId: project.id,
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          constraints: body.constraints,
          testRequirements: body.testRequirements
        }
      });

      // 默认只创建 Issue，进入需求池（pending）。
      // 若启用 PM 自动化（PM_AUTOMATION_ENABLED），则会自动分析并分配/启动 Run；否则需要手动调用 /api/issues/:id/start。
      deps.onIssueCreated?.(issue.id, "ui_create");
      return { success: true, data: { issue } };
    });

    server.post("/:id/start", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        agentId: z.string().uuid().optional(),
        roleKey: z.string().min(1).max(100).optional(),
        worktreeName: z.string().trim().min(1).max(100).optional(),
        keepaliveTtlSeconds: z.coerce.number().int().min(60).max(86_400).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const { agentId, roleKey, worktreeName, keepaliveTtlSeconds } = bodySchema.parse(request.body ?? {});

      return await startIssueRun({
        prisma: deps.prisma,
        acp: deps.acp,
        broadcastToClients: deps.broadcastToClients,
        createWorkspace: deps.createWorkspace,
        issueId: id,
        agentId,
        roleKey,
        worktreeName,
        keepaliveTtlSeconds,
      });
    });

    server.patch("/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        status: mutableIssueStatusSchema.optional(),
        archived: z.boolean().optional()
      });

      const { id } = paramsSchema.parse(request.params);
      const { status, archived } = bodySchema.parse(request.body ?? {});

      const issue = await deps.prisma.issue.findUnique({ where: { id } });
      if (!issue) {
        return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
      }
      const isSessionIssue = hasSessionLabel((issue as any).labels);
      if (issue.status === "running" && !(archived === true && isSessionIssue)) {
        return {
          success: false,
          error: { code: "ISSUE_RUNNING", message: "Issue 正在运行中，请先完成/取消 Run" }
        };
      }
      if (!status && typeof archived !== "boolean") {
        return { success: true, data: { issue } };
      }

      const nextStatus = status ?? issue.status;
      if (archived === true && !isSessionIssue && !["done", "failed", "cancelled"].includes(nextStatus)) {
        return {
          success: false,
          error: { code: "ISSUE_NOT_COMPLETED", message: "仅已完成/失败/取消的 Issue 才能归档" }
        };
      }

      const data: any = {};
      if (status) data.status = status;
      if (typeof archived === "boolean") {
        data.archivedAt = archived ? ((issue as any).archivedAt ?? new Date()) : null;
      }

      const updated = await deps.prisma.issue.update({
        where: { id },
        data
      });

      if (archived === true && deps.acp) {
        const runs = await deps.prisma.run.findMany({
          where: { issueId: id, acpSessionId: { not: null } },
          select: {
            id: true,
            acpSessionId: true,
            agent: { select: { proxyId: true } }
          }
        });

        await Promise.all(
          runs.map(async (run: any) => {
            const proxyId = String((run as any).agent?.proxyId ?? "").trim();
            const sessionId = String((run as any).acpSessionId ?? "").trim();
            if (!proxyId || !sessionId) return;
            await deps.acp
              .cancelSession({ proxyId, runId: run.id, cwd: "/workspace", sessionId })
              .catch(() => {});
          })
        );
      }

      return { success: true, data: { issue: updated } };
    });
  };
}
