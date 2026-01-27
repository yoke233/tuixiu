import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps, SendToAgent } from "../deps.js";
import type { CreateWorkspace } from "../executors/types.js";
import { dispatchExecutionForRun } from "../services/executionDispatch.js";
import { RollbackTaskBody, StartStepBody, TaskEngineError, rollbackTaskToStep, startStep } from "../services/taskEngine.js";

export function makeStepRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  createWorkspace?: CreateWorkspace;
  autoDispatch?: boolean;
}): FastifyPluginAsync {
  return async (server) => {
    server.post("/steps/:id/start", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema: z.ZodType<StartStepBody> = z.object({
        executorType: z.enum(["agent", "ci", "human", "system"]).optional(),
        roleKey: z.string().min(1).max(100).optional(),
        params: z.record(z.any()).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      try {
        const data = await startStep({ prisma: deps.prisma }, id, body);
        if (deps.autoDispatch) {
          await dispatchExecutionForRun(
            { prisma: deps.prisma, sendToAgent: deps.sendToAgent, createWorkspace: deps.createWorkspace },
            data.run.id,
          );
        }
        return { success: true, data };
      } catch (err) {
        if (err instanceof TaskEngineError) {
          return { success: false, error: { code: err.code, message: err.message, details: err.details } };
        }
        return { success: false, error: { code: "UNKNOWN", message: "启动 Step 失败", details: String(err) } };
      }
    });

    server.post("/tasks/:id/rollback", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema: z.ZodType<RollbackTaskBody> = z.object({
        stepId: z.string().uuid(),
      });
      const { id } = paramsSchema.parse(request.params);
      const body = bodySchema.parse(request.body ?? {});

      try {
        const task = await rollbackTaskToStep({ prisma: deps.prisma }, id, body);
        return { success: true, data: { task } };
      } catch (err) {
        if (err instanceof TaskEngineError) {
          return { success: false, error: { code: err.code, message: err.message, details: err.details } };
        }
        return { success: false, error: { code: "UNKNOWN", message: "回滚 Task 失败", details: String(err) } };
      }
    });
  };
}
