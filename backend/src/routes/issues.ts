import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps, SendToAgent } from "../deps.js";

const issueStatusSchema = z.enum([
  "pending",
  "running",
  "reviewing",
  "done",
  "failed",
  "cancelled"
]);

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
  sendToAgent: SendToAgent;
}): FastifyPluginAsync {
  return async (server) => {
    server.get("/", async (request) => {
      const querySchema = z.object({
        status: issueStatusSchema.optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
        offset: z.coerce.number().int().nonnegative().default(0)
      });
      const { status, limit, offset } = querySchema.parse(request.query);

      const where = status ? { status } : {};
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

      return { success: true, data: { issues, total, limit, offset } };
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
      return { success: true, data: { issue } };
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
          projectId: project.id,
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          constraints: body.constraints,
          testRequirements: body.testRequirements
        }
      });

      const onlineAgents = await deps.prisma.agent.findMany({
        where: { status: "online" },
        orderBy: { createdAt: "asc" }
      });
      const selectedAgent = onlineAgents.find(
        (a: { currentLoad: number; maxConcurrentRuns: number }) =>
          a.currentLoad < a.maxConcurrentRuns,
      );
      if (!selectedAgent) {
        return { success: true, data: { issue } };
      }

      const run = await deps.prisma.run.create({
        data: {
          issueId: issue.id,
          agentId: selectedAgent.id,
          status: "running",
          acpSessionId: issue.id
        }
      });

      await deps.prisma.issue.update({
        where: { id: issue.id },
        data: { status: "running", assignedAgentId: selectedAgent.id }
      });
      await deps.prisma.agent.update({
        where: { id: selectedAgent.id },
        data: { currentLoad: { increment: 1 } }
      });

      const promptParts: string[] = [];
      promptParts.push(`任务标题: ${issue.title}`);
      if (issue.description) promptParts.push(`任务描述:\n${issue.description}`);
      const acceptance = body.acceptanceCriteria;
      if (acceptance.length) {
        promptParts.push(`验收标准:\n${acceptance.map((x) => `- ${x}`).join("\n")}`);
      }
      const constraints = body.constraints;
      if (constraints.length) {
        promptParts.push(`约束条件:\n${constraints.map((x) => `- ${x}`).join("\n")}`);
      }
      if (body.testRequirements) {
        promptParts.push(`测试要求:\n${body.testRequirements}`);
      }

      try {
        await deps.sendToAgent(selectedAgent.proxyId, {
          type: "execute_task",
          run_id: run.id,
          session_id: run.acpSessionId ?? run.id,
          prompt: promptParts.join("\n\n")
        });
      } catch (error) {
        await deps.prisma.run.update({
          where: { id: run.id },
          data: { status: "failed", completedAt: new Date(), errorMessage: String(error) }
        });
        await deps.prisma.issue.update({
          where: { id: issue.id },
          data: { status: "failed" }
        });
        await deps.prisma.agent
          .update({ where: { id: selectedAgent.id }, data: { currentLoad: { decrement: 1 } } })
          .catch(() => {});

        return {
          success: false,
          error: {
            code: "AGENT_SEND_FAILED",
            message: "发送任务到 Agent 失败",
            details: String(error)
          },
          data: { issue, run }
        };
      }

      return { success: true, data: { issue, run } };
    });
  };
}
