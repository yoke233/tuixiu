import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { AuthHelpers } from "../auth.js";
import type { PrismaDeps, SendToAgent } from "../db.js";
import { uuidv7 } from "../utils/uuid.js";
import { deriveSandboxInstanceName } from "../utils/sandbox.js";

const sandboxStatusSchema = z.enum(["creating", "running", "stopped", "missing", "error"]);

export function makeSandboxRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  auth: AuthHelpers;
}): FastifyPluginAsync {
  return async (server) => {
    const requireAdmin = deps.auth.requireRoles(["admin"]);

    server.get("/sandboxes", { preHandler: requireAdmin }, async (request) => {
      const querySchema = z.object({
        proxyId: z.string().trim().min(1).max(100).optional(),
        status: sandboxStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(500).default(200),
        offset: z.coerce.number().int().nonnegative().default(0),
      });
      const { proxyId, status, limit, offset } = querySchema.parse(request.query);

      const where: any = {};
      if (proxyId) where.proxyId = proxyId;
      if (status) where.status = status;

      const [total, sandboxes] = await Promise.all([
        deps.prisma.sandboxInstance.count({ where } as any),
        deps.prisma.sandboxInstance.findMany({
          where,
          orderBy: { lastSeenAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            run: {
              select: {
                id: true,
                issueId: true,
                taskId: true,
                stepId: true,
                keepaliveTtlSeconds: true,
                sandboxStatus: true,
                sandboxLastSeenAt: true,
                sandboxLastError: true,
              },
            },
          },
        } as any),
      ]);

      return {
        success: true,
        data: {
          total,
          limit,
          offset,
          sandboxes: (sandboxes as any[]).map((s) => ({
            proxyId: s.proxyId,
            runId: s.runId ?? s.run?.id ?? null,
            instanceName: s.instanceName,
            provider: s.provider ?? null,
            runtime: s.runtime ?? null,
            sandboxStatus: s.status ?? s.run?.sandboxStatus ?? null,
            sandboxLastSeenAt: s.lastSeenAt ?? s.run?.sandboxLastSeenAt ?? null,
            keepaliveTtlSeconds: s.run?.keepaliveTtlSeconds ?? null,
            issueId: s.run?.issueId ?? null,
            taskId: s.run?.taskId ?? null,
            stepId: s.run?.stepId ?? null,
            sandboxLastError: s.lastError ?? s.run?.sandboxLastError ?? null,
          })),
        },
      };
    });

    server.post("/sandboxes/control", { preHandler: requireAdmin }, async (request) => {
      const bodySchema = z.object({
        runId: z.string().uuid().optional(),
        instanceName: z.string().trim().min(1).max(200).optional(),
        proxyId: z.string().trim().min(1).max(100).optional(),
        action: z.enum([
          "inspect",
          "ensure_running",
          "stop",
          "remove",
          "prune_orphans",
          "gc",
          "remove_workspace",
          "report_inventory",
          "remove_image",
        ]),
        image: z.string().trim().min(1).max(500).optional(),
      });
      const body = bodySchema.parse(request.body ?? {});

      if (!deps.sendToAgent) {
        return { success: false, error: { code: "NO_AGENT_GATEWAY", message: "Agent 网关未配置" } };
      }

      if (body.action === "report_inventory") {
        if (!body.proxyId) {
          return {
            success: false,
            error: { code: "BAD_REQUEST", message: "action=report_inventory 需要 proxyId" },
          };
        }
        const expected = await deps.prisma.sandboxInstance.findMany({
          where: { proxyId: body.proxyId } as any,
          select: { instanceName: true, runId: true } as any,
          take: 500,
        } as any);

        await deps.sendToAgent(body.proxyId, {
          type: "sandbox_control",
          action: "report_inventory",
          expected_instances: (expected as any[]).map((item) => ({
            instance_name: item.instanceName,
            run_id: item.runId ?? null,
          })),
        } as any);
        return { success: true, data: { ok: true } };
      }

      if (body.action === "prune_orphans") {
        if (!body.proxyId) {
          return {
            success: false,
            error: { code: "BAD_REQUEST", message: "action=prune_orphans 需要 proxyId" },
          };
        }
        const expected = await deps.prisma.sandboxInstance.findMany({
          where: { proxyId: body.proxyId } as any,
          select: { instanceName: true, runId: true } as any,
          take: 500,
        } as any);

        await deps.sendToAgent(body.proxyId, {
          type: "sandbox_control",
          action: "prune_orphans",
          expected_instances: (expected as any[]).map((item) => ({
            instance_name: item.instanceName,
            run_id: item.runId ?? null,
          })),
        } as any);
        return { success: true, data: { ok: true } };
      }

      if (body.action === "gc") {
        if (!body.proxyId) {
          return {
            success: false,
            error: { code: "BAD_REQUEST", message: "action=gc 需要 proxyId" },
          };
        }
        const expected = await deps.prisma.sandboxInstance.findMany({
          where: { proxyId: body.proxyId } as any,
          select: { instanceName: true, runId: true } as any,
          take: 500,
        } as any);

        await deps.sendToAgent(body.proxyId, {
          type: "sandbox_control",
          action: "gc",
          request_id: uuidv7(),
          expected_instances: (expected as any[]).map((item) => ({
            instance_name: item.instanceName,
            run_id: item.runId ?? null,
          })),
          dry_run: true,
        } as any);
        return { success: true, data: { ok: true } };
      }

      if (body.action === "remove_image") {
        if (!body.proxyId) {
          return {
            success: false,
            error: { code: "BAD_REQUEST", message: "action=remove_image 需要 proxyId" },
          };
        }
        const image = body.image?.trim() ?? "";
        if (!image) {
          return {
            success: false,
            error: { code: "BAD_REQUEST", message: "action=remove_image 需要 image" },
          };
        }
        await deps.sendToAgent(body.proxyId, {
          type: "sandbox_control",
          action: "remove_image",
          image,
        } as any);
        return { success: true, data: { ok: true } };
      }

      if (body.runId) {
        const run = await deps.prisma.run.findUnique({
          where: { id: body.runId },
          include: { agent: true } as any,
        } as any);
        if (!run) {
          return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
        }
        if (!(run as any).agent) {
          return {
            success: false,
            error: { code: "NO_AGENT", message: "该 Run 未绑定 Agent，无法下发控制命令" },
          };
        }

        const proxyId = String((run as any).agent.proxyId ?? "").trim();
        if (!proxyId) {
          return { success: false, error: { code: "BAD_RUN", message: "Run.agent.proxyId 缺失" } };
        }
        const instanceName =
          typeof (run as any).sandboxInstanceName === "string" &&
          (run as any).sandboxInstanceName.trim()
            ? String((run as any).sandboxInstanceName).trim()
            : deriveSandboxInstanceName(String((run as any).id));

        await deps.sendToAgent(proxyId, {
          type: "sandbox_control",
          run_id: (run as any).id,
          instance_name: instanceName,
          action: body.action,
        } as any);

        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: (run as any).id,
              source: "user",
              type: "sandbox.control.requested",
              payload: { action: body.action, proxyId, instance_name: instanceName } as any,
            } as any,
          } as any)
          .catch(() => {});

        return { success: true, data: { ok: true } };
      }

      const requestedInstanceName = body.instanceName?.trim() ?? "";
      if (!requestedInstanceName) {
        return {
          success: false,
          error: { code: "BAD_REQUEST", message: "需要提供 runId 或 instanceName" },
        };
      }

      if (body.proxyId) {
        const sandbox = await deps.prisma.sandboxInstance.findUnique({
          where: {
            proxyId_instanceName: { proxyId: body.proxyId, instanceName: requestedInstanceName },
          } as any,
        } as any);
        if (!sandbox) {
          return {
            success: false,
            error: { code: "NOT_FOUND", message: "SandboxInstance 不存在" },
          };
        }

        const item: any = sandbox;
        const proxyId = String(item.proxyId ?? "").trim();
        if (!proxyId) {
          return {
            success: false,
            error: { code: "BAD_DATA", message: "SandboxInstance.proxyId 缺失" },
          };
        }

        await deps.sendToAgent(proxyId, {
          type: "sandbox_control",
          ...(item.runId ? { run_id: item.runId } : {}),
          instance_name: requestedInstanceName,
          action: body.action,
        } as any);

        if (item.runId) {
          await deps.prisma.event
            .create({
              data: {
                id: uuidv7(),
                runId: item.runId,
                source: "user",
                type: "sandbox.control.requested",
                payload: {
                  action: body.action,
                  proxyId,
                  instance_name: requestedInstanceName,
                } as any,
              } as any,
            } as any)
            .catch(() => {});
        }

        return { success: true, data: { ok: true } };
      }

      const resolved = await deps.prisma.sandboxInstance.findMany({
        where: { instanceName: requestedInstanceName } as any,
        take: 2,
      } as any);
      if (!resolved.length) {
        return { success: false, error: { code: "NOT_FOUND", message: "SandboxInstance 不存在" } };
      }
      if (resolved.length > 1) {
        return {
          success: false,
          error: { code: "CONFLICT", message: "instanceName 存在于多个 proxy，请指定 proxyId" },
        };
      }

      const item: any = resolved[0];
      const proxyId = String(item.proxyId ?? "").trim();
      if (!proxyId) {
        return {
          success: false,
          error: { code: "BAD_DATA", message: "SandboxInstance.proxyId 缺失" },
        };
      }

      await deps.sendToAgent(proxyId, {
        type: "sandbox_control",
        ...(item.runId ? { run_id: item.runId } : {}),
        instance_name: requestedInstanceName,
        action: body.action,
      } as any);

      if (item.runId) {
        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: item.runId,
              source: "user",
              type: "sandbox.control.requested",
              payload: {
                action: body.action,
                proxyId,
                instance_name: requestedInstanceName,
              } as any,
            } as any,
          } as any)
          .catch(() => {});
      }

      return { success: true, data: { ok: true } };
    });
  };
}
