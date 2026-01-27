import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";

import { extractAgentTextFromEvents, extractTaggedCodeBlock } from "./agentOutput.js";

type TerminalOutcome = "completed" | "failed" | "cancelled";

async function ensureArtifactOnce(opts: {
  prisma: PrismaDeps;
  runId: string;
  type: "report" | "ci_result";
  content: any;
}) {
  const existing = await opts.prisma.artifact
    .findFirst({ where: { runId: opts.runId, type: opts.type } as any, orderBy: { createdAt: "desc" } })
    .catch(() => null);
  if (existing) return;

  await opts.prisma.artifact
    .create({
      data: {
        id: uuidv7(),
        runId: opts.runId,
        type: opts.type,
        content: opts.content as any,
      },
    })
    .catch(() => {});
}

async function maybeCreateAgentArtifacts(deps: { prisma: PrismaDeps }, run: any, step: any) {
  if (run.executorType !== "agent") return;
  const kind = String(step?.kind ?? "").trim();
  if (!kind) return;
  if (!["prd.generate", "code.review", "test.run"].includes(kind)) return;

  const events = await deps.prisma.event
    .findMany({ where: { runId: run.id }, orderBy: { timestamp: "asc" }, take: 5000 })
    .catch(() => []);
  const agentText = extractAgentTextFromEvents(events as any[]);
  if (!agentText.trim()) return;

  if (kind === "test.run") {
    const jsonText = extractTaggedCodeBlock(agentText, "CI_RESULT_JSON");
    let parsed: any = null;
    try {
      parsed = jsonText ? JSON.parse(jsonText) : null;
    } catch {
      parsed = null;
    }
    const content = parsed && typeof parsed === "object" ? parsed : { passed: true, raw: agentText.slice(-4000) };
    await ensureArtifactOnce({ prisma: deps.prisma, runId: run.id, type: "ci_result", content });
    return;
  }

  const jsonText = extractTaggedCodeBlock(agentText, "REPORT_JSON");
  let parsed: any = null;
  try {
    parsed = jsonText ? JSON.parse(jsonText) : null;
  } catch {
    parsed = null;
  }

  const reportKind = kind === "prd.generate" ? "prd" : "review";
  const content =
    parsed && typeof parsed === "object"
      ? { ...parsed, kind: parsed.kind ?? reportKind, markdown: parsed.markdown ?? agentText }
      : { kind: reportKind, markdown: agentText };

  await ensureArtifactOnce({ prisma: deps.prisma, runId: run.id, type: "report", content });
}

function lastStepKind(steps: any[]): string {
  const last = [...steps].sort((a, b) => Number(a.order) - Number(b.order)).slice(-1)[0];
  return typeof last?.kind === "string" ? last.kind : "";
}

function issueStatusOnTaskCompleted(task: any): "pending" | "done" {
  const kind = lastStepKind(Array.isArray(task.steps) ? task.steps : []);
  return kind === "pr.merge" ? "done" : "pending";
}

export async function advanceTaskFromRunTerminal(
  deps: { prisma: PrismaDeps },
  runId: string,
  outcome: TerminalOutcome,
  extra?: { errorMessage?: string },
): Promise<{
  handled: boolean;
  taskId?: string;
  stepId?: string;
}> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { task: { include: { steps: { orderBy: { order: "asc" } } } }, step: true },
  });
  if (!run || !(run as any).taskId || !(run as any).stepId) return { handled: false };

  const task = (run as any).task as any;
  const step = (run as any).step as any;
  if (!task || !step) return { handled: false };

  if (outcome === "failed") {
    await deps.prisma.step.update({ where: { id: step.id }, data: { status: "failed" } as any }).catch(() => {});
    await deps.prisma.task.update({ where: { id: task.id }, data: { status: "failed" } as any }).catch(() => {});
    await deps.prisma.issue
      .update({ where: { id: task.issueId }, data: { status: "failed" } as any })
      .catch(() => {});

    if (extra?.errorMessage) {
      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId,
            source: "system",
            type: "task.step.failed",
            payload: { taskId: task.id, stepId: step.id, error: extra.errorMessage } as any,
          },
        })
        .catch(() => {});
    }

    return { handled: true, taskId: task.id, stepId: step.id };
  }

  if (outcome === "cancelled") {
    await deps.prisma.step.update({ where: { id: step.id }, data: { status: "cancelled" } as any }).catch(() => {});
    await deps.prisma.task.update({ where: { id: task.id }, data: { status: "cancelled" } as any }).catch(() => {});
    await deps.prisma.issue
      .update({ where: { id: task.issueId }, data: { status: "cancelled" } as any })
      .catch(() => {});
    return { handled: true, taskId: task.id, stepId: step.id };
  }

  await maybeCreateAgentArtifacts(deps, run, step).catch(() => {});

  await deps.prisma.step.update({ where: { id: step.id }, data: { status: "completed" } as any }).catch(() => {});

  const steps = Array.isArray(task.steps) ? (task.steps as any[]) : [];
  const idx = steps.findIndex((s) => s.id === step.id);
  const next = idx >= 0 ? steps[idx + 1] : null;

  if (next) {
    if (next.status === "pending") {
      await deps.prisma.step.update({ where: { id: next.id }, data: { status: "ready" } as any }).catch(() => {});
    }
    await deps.prisma.task
      .update({ where: { id: task.id }, data: { status: "running", currentStepId: next.id } as any })
      .catch(() => {});

    await deps.prisma.issue.update({ where: { id: task.issueId }, data: { status: "running" } as any }).catch(() => {});
    return { handled: true, taskId: task.id, stepId: step.id };
  }

  await deps.prisma.task.update({ where: { id: task.id }, data: { status: "completed" } as any }).catch(() => {});
  await deps.prisma.issue
    .update({ where: { id: task.issueId }, data: { status: issueStatusOnTaskCompleted(task) } as any })
    .catch(() => {});

  return { handled: true, taskId: task.id, stepId: step.id };
}

export async function setTaskBlockedFromRun(
  deps: { prisma: PrismaDeps },
  runId: string,
  reason: { code: string; message: string },
): Promise<{ handled: boolean; taskId?: string; stepId?: string }> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { task: { include: { steps: { orderBy: { order: "asc" } } } }, step: true },
  });
  if (!run || !(run as any).taskId || !(run as any).stepId) return { handled: false };

  const task = (run as any).task as any;
  const step = (run as any).step as any;
  if (!task || !step) return { handled: false };

  await deps.prisma.task.update({ where: { id: task.id }, data: { status: "blocked" } as any }).catch(() => {});
  await deps.prisma.issue.update({ where: { id: task.issueId }, data: { status: "reviewing" } as any }).catch(() => {});

  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId,
        source: "system",
        type: "task.blocked",
        payload: { taskId: task.id, stepId: step.id, reason } as any,
      },
    })
    .catch(() => {});

  return { handled: true, taskId: task.id, stepId: step.id };
}
