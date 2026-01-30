import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { PrismaDeps, SendToAgent } from "../db.js";
import type { CreateWorkspace } from "../executors/types.js";
import type { AcpTunnel } from "../modules/acp/acpTunnel.js";
import { dispatchExecutionForRun } from "../modules/workflow/executionDispatch.js";
import { triggerTaskAutoAdvance } from "../modules/workflow/taskAutoAdvance.js";
import { RollbackTaskBody, StartStepBody, TaskEngineError, rollbackTaskToStep, startStep } from "../modules/workflow/taskEngine.js";

export function makeStepRoutes(deps: {
  prisma: PrismaDeps;
  sendToAgent?: SendToAgent;
  acp?: AcpTunnel;
  createWorkspace?: CreateWorkspace;
  autoDispatch?: boolean;
  broadcastToClients?: (payload: unknown) => void;
  sandboxGitPush?: (opts: { run: any; branch: string; project: any }) => Promise<void>;
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
            {
              prisma: deps.prisma,
              sendToAgent: deps.sendToAgent,
              acp: deps.acp,
              createWorkspace: deps.createWorkspace,
              broadcastToClients: deps.broadcastToClients,
              sandboxGitPush: deps.sandboxGitPush,
            },
            data.run.id,
          );
        }

        const issueId = (data.task as any)?.issueId;
        const taskId = (data.task as any)?.id;
        const stepId = (data.step as any)?.id;
        if (issueId && taskId) {
          deps.broadcastToClients?.({ type: "task_updated", issue_id: issueId, task_id: taskId, step_id: stepId, run_id: data.run.id });
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
        deps.broadcastToClients?.({
          type: "task_updated",
          issue_id: (task as any).issueId,
          task_id: (task as any).id,
          step_id: body.stepId,
        });
        triggerTaskAutoAdvance(
          {
            prisma: deps.prisma,
            sendToAgent: deps.sendToAgent,
            acp: deps.acp,
            createWorkspace: deps.createWorkspace,
            broadcastToClients: deps.broadcastToClients,
            sandboxGitPush: deps.sandboxGitPush,
          },
          { issueId: (task as any).issueId, taskId: (task as any).id, trigger: "task_rolled_back" },
        );
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
