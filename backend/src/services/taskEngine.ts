import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { getTaskTemplate, TASK_TEMPLATES } from "./taskTemplates.js";

type ExecutorType = "agent" | "ci" | "human" | "system";

export type CreateTaskBody = {
  templateKey: string;
  track?: "quick" | "planning" | "enterprise";
};

export type StartStepBody = {
  executorType?: ExecutorType;
  roleKey?: string;
  params?: Record<string, unknown>;
};

export type RollbackTaskBody = {
  stepId: string;
};

export class TaskEngineError extends Error {
  code: string;
  details?: string;

  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function normalizeExecutorType(value: unknown): ExecutorType | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "agent" || v === "ci" || v === "human" || v === "system") return v;
  return null;
}

function normalizeTaskTrack(value: unknown): "quick" | "planning" | "enterprise" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "quick" || v === "planning" || v === "enterprise") return v;
  return null;
}

function inferTaskTrackFromTemplateKey(templateKey: string): "quick" | "planning" | "enterprise" | null {
  const k = String(templateKey ?? "").trim().toLowerCase();
  if (!k) return null;
  if (k.startsWith("quick.")) return "quick";
  if (k.startsWith("planning.")) return "planning";
  if (k.startsWith("enterprise.")) return "enterprise";

  if (k === "template.prd.only") return "planning";
  if (k === "template.dev.full") return "quick";
  if (k === "template.test.only") return "quick";
  if (k === "template.admin.session") return "quick";

  return null;
}

function toIssueStatusFromStepStatus(stepStatus: string): "pending" | "running" | "reviewing" | "done" | "failed" | "cancelled" {
  if (stepStatus === "waiting_ci" || stepStatus === "waiting_human") return "reviewing";
  if (stepStatus === "running" || stepStatus === "ready") return "running";
  if (stepStatus === "failed") return "failed";
  if (stepStatus === "cancelled") return "cancelled";
  return "running";
}

export function listTaskTemplates() {
  return TASK_TEMPLATES.map((t) => ({
    key: t.key,
    displayName: t.displayName,
    description: t.description ?? "",
    track: t.track ?? null,
    deprecated: Boolean(t.deprecated),
    steps: t.steps.map((s) => ({ key: s.key, kind: s.kind, executorType: s.executorType })),
  }));
}

export async function createTaskFromTemplate(
  deps: { prisma: PrismaDeps },
  issueId: string,
  body: CreateTaskBody,
): Promise<any> {
  const templateKey = String(body.templateKey ?? "").trim();
  const template = getTaskTemplate(templateKey);
  if (!template) {
    throw new TaskEngineError("BAD_TEMPLATE", "未知的模板", templateKey);
  }

  const track = normalizeTaskTrack((body as any).track) ?? template.track ?? inferTaskTrackFromTemplateKey(template.key);

  const issue = await deps.prisma.issue.findUnique({
    where: { id: issueId },
    include: { project: true },
  });
  if (!issue) {
    throw new TaskEngineError("NOT_FOUND", "Issue 不存在");
  }

  const project = (issue as any).project;
  const baseBranch = typeof project?.defaultBranch === "string" && project.defaultBranch.trim() ? project.defaultBranch.trim() : "main";

  const taskId = uuidv7();
  const steps = template.steps.map((s, idx) => ({
    id: uuidv7(),
    key: s.key,
    kind: s.kind,
    order: idx + 1,
    status: idx === 0 ? "ready" : "pending",
    executorType: s.executorType,
    roleKey: s.roleKey ?? null,
    params: s.params ?? undefined,
    dependsOn: undefined,
  }));
  const firstStepId = steps[0]?.id ?? null;
  if (!firstStepId) {
    throw new TaskEngineError("BAD_TEMPLATE", "模板缺少步骤", templateKey);
  }

  const created = await deps.prisma.task.create({
    data: {
      id: taskId,
      issueId,
      templateKey: template.key,
      track: track ?? undefined,
      status: "pending",
      baseBranch,
      currentStepId: firstStepId,
      steps: { create: steps as any },
    } as any,
    include: { steps: { orderBy: { order: "asc" } } },
  });

  return created;
}

export async function listTasksForIssue(deps: { prisma: PrismaDeps }, issueId: string): Promise<any[]> {
  return await deps.prisma.task.findMany({
    where: { issueId },
    include: {
      steps: { orderBy: { order: "asc" } },
      runs: { orderBy: { startedAt: "desc" }, take: 200 },
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTaskById(deps: { prisma: PrismaDeps }, taskId: string): Promise<any> {
  const task = await deps.prisma.task.findUnique({
    where: { id: taskId },
    include: {
      steps: { orderBy: { order: "asc" } },
      runs: { orderBy: { startedAt: "desc" }, take: 50 },
      issue: { include: { project: true } },
    },
  });
  if (!task) throw new TaskEngineError("NOT_FOUND", "Task 不存在");
  return task;
}

export async function rollbackTaskToStep(
  deps: { prisma: PrismaDeps },
  taskId: string,
  body: RollbackTaskBody,
): Promise<any> {
  const stepId = String(body.stepId ?? "").trim();
  if (!stepId) throw new TaskEngineError("BAD_REQUEST", "stepId 不能为空");

  const task = await deps.prisma.task.findUnique({
    where: { id: taskId },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (!task) throw new TaskEngineError("NOT_FOUND", "Task 不存在");

  const steps = (task as any).steps as any[];
  const target = steps.find((s) => s.id === stepId) ?? null;
  if (!target) throw new TaskEngineError("NOT_FOUND", "Step 不存在");

  const targetOrder = Number(target.order);
  if (!Number.isFinite(targetOrder) || targetOrder <= 0) {
    throw new TaskEngineError("BAD_STEP", "Step 顺序不合法");
  }

  await deps.prisma.step.updateMany({
    where: { taskId: task.id, order: { gt: targetOrder } as any } as any,
    data: { status: "pending" } as any,
  });
  await deps.prisma.step.update({
    where: { id: target.id },
    data: { status: "ready" } as any,
  });

  const updatedTask = await deps.prisma.task.update({
    where: { id: task.id },
    data: { status: "running", currentStepId: target.id } as any,
    include: { steps: { orderBy: { order: "asc" } } },
  });

  await deps.prisma.issue
    .update({ where: { id: updatedTask.issueId }, data: { status: "running" } as any })
    .catch(() => {});

  return updatedTask;
}

export async function startStep(
  deps: { prisma: PrismaDeps },
  stepId: string,
  body: StartStepBody,
): Promise<{ task: any; step: any; run: any }> {
  const step = await deps.prisma.step.findUnique({
    where: { id: stepId },
    include: { task: { include: { issue: { include: { project: true } } } } },
  });
  if (!step) throw new TaskEngineError("NOT_FOUND", "Step 不存在");

  const task = (step as any).task as any;
  if (!task) throw new TaskEngineError("BAD_STEP", "Step 未绑定 Task");

  if ((step as any).status !== "ready") {
    throw new TaskEngineError("NOT_READY", "Step 不是 ready 状态，无法启动");
  }

  const overrideExecutor = normalizeExecutorType(body.executorType);
  const executorType = overrideExecutor ?? normalizeExecutorType((step as any).executorType) ?? "agent";
  const roleKey = typeof body.roleKey === "string" ? body.roleKey.trim() : (step as any).roleKey ?? null;
  const params = body.params && typeof body.params === "object" ? body.params : ((step as any).params ?? undefined);

  if (overrideExecutor || body.roleKey !== undefined || body.params !== undefined) {
    await deps.prisma.step.update({
      where: { id: (step as any).id },
      data: {
        executorType,
        roleKey: roleKey ? roleKey : null,
        params: params ?? undefined,
      } as any,
    });
  }

  const prev = await deps.prisma.run.findFirst({
    where: { stepId: (step as any).id } as any,
    orderBy: { attempt: "desc" },
    select: { attempt: true },
  });
  const attempt = prev && Number.isFinite((prev as any).attempt) ? Number((prev as any).attempt) + 1 : 1;

  const stepStatus =
    executorType === "ci" ? "waiting_ci" : executorType === "human" ? "waiting_human" : "running";
  const runStatus = executorType === "ci" ? "waiting_ci" : "running";

  const run = await deps.prisma.run.create({
    data: {
      id: uuidv7(),
      issueId: task.issueId,
      agentId: null,
      executorType,
      taskId: task.id,
      stepId: (step as any).id,
      attempt,
      status: runStatus,
      workspaceType: task.workspaceType ?? null,
      workspacePath: task.workspacePath ?? null,
      branchName: task.branchName ?? null,
      metadata: {
        step: { key: (step as any).key, kind: (step as any).kind, executorType, roleKey, params },
      } as any,
    } as any,
  });

  const updatedStep = await deps.prisma.step.update({
    where: { id: (step as any).id },
    data: { status: stepStatus } as any,
  });

  const updatedTask = await deps.prisma.task.update({
    where: { id: task.id },
    data: { status: "running", currentStepId: (step as any).id } as any,
  });

  await deps.prisma.issue
    .update({
      where: { id: task.issueId },
      data: { status: toIssueStatusFromStepStatus(stepStatus) } as any,
    })
    .catch(() => {});

  return { task: updatedTask, step: updatedStep, run };
}

