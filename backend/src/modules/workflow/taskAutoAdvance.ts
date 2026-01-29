import type { PrismaDeps, SendToAgent } from "../../deps.js";
import type { CreateWorkspace } from "../../executors/types.js";
import { uuidv7 } from "../../utils/uuid.js";
import { dispatchExecutionForRun } from "./executionDispatch.js";
import { TaskEngineError, startStep } from "./taskEngine.js";
import { isPmAutomationEnabled } from "../pm/pmLlm.js";
import { getPmPolicyFromBranchProtection } from "../pm/pmPolicy.js";
import type { AcpTunnel } from "../acp/acpTunnel.js";

type AutoAdvanceTrigger = "task_created" | "step_completed" | "task_rolled_back" | "ci_completed" | "manual";
type QueueTask = () => Promise<void>;

function enqueueByKey(queue: Map<string, Promise<void>>, key: string, task: QueueTask): Promise<void> {
  const prev = queue.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (queue.get(key) === next) queue.delete(key);
    });
  queue.set(key, next);
  return next;
}

function normalizeExecutorType(value: unknown): "agent" | "ci" | "human" | "system" {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "agent" || v === "ci" || v === "human" || v === "system") return v;
  return "agent";
}

function isTerminalTaskStatus(value: unknown): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "blocked" || v === "completed" || v === "failed" || v === "cancelled";
}

function hasWorkspaceForNonAgent(task: any): boolean {
  const workspacePath = typeof task?.workspacePath === "string" ? task.workspacePath.trim() : "";
  const branchName = typeof task?.branchName === "string" ? task.branchName.trim() : "";
  return Boolean(workspacePath && branchName);
}

async function recordAutoAdvanceEvent(deps: { prisma: PrismaDeps }, runId: string, payload: any) {
  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId,
        source: "system",
        type: "task.auto_advance.started",
        payload,
      } as any,
    })
    .catch(() => {});
}

export async function autoAdvanceTaskOnce(
  deps: {
    prisma: PrismaDeps;
    sendToAgent?: SendToAgent;
    acp?: AcpTunnel;
    createWorkspace?: CreateWorkspace;
    broadcastToClients?: (payload: unknown) => void;
    startStep?: typeof startStep;
    dispatchExecutionForRun?: typeof dispatchExecutionForRun;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
  },
  opts: { issueId: string; taskId: string; trigger: AutoAdvanceTrigger },
): Promise<void> {
  if (!isPmAutomationEnabled()) return;

  const log = deps.log ?? (() => {});
  const issueId = String(opts.issueId ?? "").trim();
  const taskId = String(opts.taskId ?? "").trim();
  if (!issueId || !taskId) return;

  const task = await deps.prisma.task.findUnique({
    where: { id: taskId },
    include: {
      steps: { orderBy: { order: "asc" } },
      issue: { include: { project: true } },
    } as any,
  });
  if (!task) return;
  if (String((task as any).issueId ?? "") !== issueId) return;

  if (isTerminalTaskStatus((task as any).status)) return;

  const steps = Array.isArray((task as any).steps) ? ((task as any).steps as any[]) : [];
  const currentStepId = typeof (task as any).currentStepId === "string" ? (task as any).currentStepId : null;
  if (!currentStepId) return;

  const step = steps.find((s) => String(s?.id ?? "") === currentStepId) ?? null;
  if (!step) return;
  if (String(step.status ?? "") !== "ready") return;

  const executorType = normalizeExecutorType(step.executorType);
  if (executorType === "human") return;

  const issue: any = (task as any).issue;
  const project: any = issue?.project;
  const { policy } = getPmPolicyFromBranchProtection(project?.branchProtection);

  const stepKind = String(step.kind ?? "").trim();
  if (stepKind === "pr.create" && policy.automation.autoCreatePr === false) return;

  if (executorType === "agent") {
    if (!deps.acp) return;
    const workspacePath = typeof (task as any).workspacePath === "string" ? (task as any).workspacePath.trim() : "";
    const branchName = typeof (task as any).branchName === "string" ? (task as any).branchName.trim() : "";
    if (!workspacePath || !branchName) {
      if (!deps.createWorkspace) return;
    }
  } else {
    if (!hasWorkspaceForNonAgent(task)) return;
  }

  const startStepFn = deps.startStep ?? startStep;
  const dispatchFn = deps.dispatchExecutionForRun ?? dispatchExecutionForRun;

  let started: { task: any; step: any; run: any } | null = null;
  try {
    started = await startStepFn({ prisma: deps.prisma }, step.id, {});
  } catch (err) {
    if (err instanceof TaskEngineError) {
      if (err.code === "NOT_READY") return;
    }
    log("task auto start failed", { issueId, taskId, stepId: step.id, trigger: opts.trigger, err: String(err) });
    return;
  }

  const runId = String((started as any).run?.id ?? "");
  if (runId) {
    await recordAutoAdvanceEvent(deps, runId, { trigger: opts.trigger, taskId, stepId: step.id }).catch(() => {});
  }

  await dispatchFn(
    {
      prisma: deps.prisma,
      sendToAgent: deps.sendToAgent,
      acp: deps.acp,
      createWorkspace: deps.createWorkspace,
      broadcastToClients: deps.broadcastToClients,
    },
    (started as any).run.id,
  );

  deps.broadcastToClients?.({
    type: "task_updated",
    issue_id: issueId,
    task_id: taskId,
    step_id: step.id,
    run_id: (started as any).run.id,
  });
}

const issueQueue = new Map<string, Promise<void>>();

export function triggerTaskAutoAdvance(
  deps: {
    prisma: PrismaDeps;
    sendToAgent?: SendToAgent;
    acp?: AcpTunnel;
    createWorkspace?: CreateWorkspace;
    broadcastToClients?: (payload: unknown) => void;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
  },
  opts: { issueId: string; taskId: string; trigger: AutoAdvanceTrigger },
) {
  if (!isPmAutomationEnabled()) return;
  const issueId = String(opts.issueId ?? "").trim();
  const taskId = String(opts.taskId ?? "").trim();
  if (!issueId || !taskId) return;

  void enqueueByKey(issueQueue, issueId, async () => {
    await autoAdvanceTaskOnce(deps, { issueId, taskId, trigger: opts.trigger });
  });
}
