import { apiPost } from "./client";
import type { ExecutorType, Run, Step, Task } from "../types";

export type StartStepInput = {
  executorType?: ExecutorType;
  roleKey?: string;
  params?: Record<string, unknown>;
};

export async function startStep(stepId: string, input: StartStepInput): Promise<{ task: Task; step: Step; run: Run }> {
  const data = await apiPost<{ task: Task; step: Step; run: Run }>(`/steps/${stepId}/start`, input);
  return data;
}

export async function rollbackTask(taskId: string, stepId: string): Promise<Task> {
  const data = await apiPost<{ task: Task }>(`/tasks/${taskId}/rollback`, { stepId });
  return data.task;
}

