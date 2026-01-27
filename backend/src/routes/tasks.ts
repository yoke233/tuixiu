import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import {
  TaskEngineError,
  createTaskFromTemplate,
  getTaskById,
  listTaskTemplates,
  listTasksForIssue,
} from "../services/taskEngine.js";

export function makeTaskRoutes(deps: {
  prisma: PrismaDeps;
  broadcastToClients?: (payload: unknown) => void;
}): FastifyPluginAsync {
  return async (server) => {
    server.get("/task-templates", async () => {
      return { success: true, data: { templates: listTaskTemplates() } };
    });

    server.get("/issues/:id/tasks", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      const tasks = await listTasksForIssue({ prisma: deps.prisma }, id);
      return { success: true, data: { tasks } };
    });

    server.post("/issues/:id/tasks", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({ templateKey: z.string().min(1).max(100) });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      try {
        const task = await createTaskFromTemplate({ prisma: deps.prisma }, id, body);
        deps.broadcastToClients?.({ type: "task_created", issue_id: id, task_id: (task as any).id });
        return { success: true, data: { task } };
      } catch (err) {
        if (err instanceof TaskEngineError) {
          return { success: false, error: { code: err.code, message: err.message, details: err.details } };
        }
        return { success: false, error: { code: "UNKNOWN", message: "创建 Task 失败", details: String(err) } };
      }
    });

    server.get("/tasks/:id", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const { id } = paramsSchema.parse(request.params);

      try {
        const task = await getTaskById({ prisma: deps.prisma }, id);
        return { success: true, data: { task } };
      } catch (err) {
        if (err instanceof TaskEngineError) {
          return { success: false, error: { code: err.code, message: err.message, details: err.details } };
        }
        return { success: false, error: { code: "UNKNOWN", message: "读取 Task 失败", details: String(err) } };
      }
    });
  };
}

