import type { PrismaDeps, SendToAgent } from "../../deps.js";
import type { CreateWorkspace } from "../../executors/types.js";
import { startAcpAgentExecution } from "../../executors/acpAgentExecutor.js";
import type { AcpTunnel } from "../acp/acpTunnel.js";
import { startCiExecution } from "../../executors/ciExecutor.js";
import { startHumanExecution } from "../../executors/humanExecutor.js";
import { startSystemExecution } from "../../executors/systemExecutor.js";
import { advanceTaskFromRunTerminal } from "./taskProgress.js";
import { triggerTaskAutoAdvance } from "./taskAutoAdvance.js";

export async function dispatchExecutionForRun(
  deps: {
    prisma: PrismaDeps;
    sendToAgent?: SendToAgent;
    acp?: AcpTunnel;
    createWorkspace?: CreateWorkspace;
    broadcastToClients?: (payload: unknown) => void;
  },
  runId: string,
): Promise<{ success: boolean; error?: string }> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    select: { id: true, issueId: true, taskId: true, stepId: true, executorType: true, agentId: true },
  });
  if (!run) return { success: false, error: "Run 不存在" };

  const executorType = String((run as any).executorType ?? "agent").toLowerCase();
  try {
    if (executorType === "agent") {
      if (!deps.acp) throw new Error("acpTunnel 未配置");
      await startAcpAgentExecution({ prisma: deps.prisma, acp: deps.acp, createWorkspace: deps.createWorkspace }, runId);
      return { success: true };
    }
    if (executorType === "human") {
      await startHumanExecution({ prisma: deps.prisma }, runId);
      return { success: true };
    }
    if (executorType === "ci") {
      await startCiExecution({ prisma: deps.prisma }, runId);
      return { success: true };
    }
    if (executorType === "system") {
      const sysRes = await startSystemExecution({ prisma: deps.prisma }, runId);
      if ((run as any).taskId) {
        deps.broadcastToClients?.({
          type: "task_updated",
          issue_id: (run as any).issueId,
          task_id: (run as any).taskId,
          step_id: (run as any).stepId,
          run_id: (run as any).id,
        });
        if (sysRes.executed) {
          triggerTaskAutoAdvance(
            {
              prisma: deps.prisma,
              sendToAgent: deps.sendToAgent,
              acp: deps.acp,
              createWorkspace: deps.createWorkspace,
              broadcastToClients: deps.broadcastToClients,
            },
            { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "step_completed" },
          );
        }
      }
      return { success: true };
    }

    throw new Error(`未知 executorType: ${executorType}`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    await deps.prisma.run
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          completedAt: new Date(),
          failureReason: "executor_failed",
          errorMessage,
        } as any,
      })
      .catch(() => {});

    const advanced = await advanceTaskFromRunTerminal({ prisma: deps.prisma }, runId, "failed", { errorMessage }).catch(
      () => ({ handled: false }),
    );
    if (advanced.handled && (run as any).taskId) {
      deps.broadcastToClients?.({
        type: "task_updated",
        issue_id: (run as any).issueId,
        task_id: (run as any).taskId,
        step_id: (run as any).stepId,
        run_id: (run as any).id,
        reason: "executor_failed",
      });
    }

    const latest = await deps.prisma.run.findUnique({ where: { id: runId }, select: { agentId: true } }).catch(() => null);
    const agentId = latest ? ((latest as any).agentId as string | null) : null;
    if (agentId) {
      await deps.prisma.agent
        .update({ where: { id: agentId }, data: { currentLoad: { decrement: 1 } } })
        .catch(() => {});
    }

    return { success: false, error: errorMessage };
  }
}
