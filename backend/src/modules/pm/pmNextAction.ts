import type { PrismaDeps } from "../../deps.js";
import { toApprovalSummary, type ApprovalSummary } from "../approvals/approvalRequests.js";

type NextActionSource = "approval" | "task" | "auto_review" | "issue" | "fallback";

export type PmNextAction = {
  issueId: string;
  action: string;
  reason: string;
  source: NextActionSource;
  taskId: string | null;
  step: { id: string; key: string; kind: string; status: string; executorType: string } | null;
  run: { id: string; status: string } | null;
  approval: ApprovalSummary | null;
};

function parseDate(value: unknown): number {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : 0;
}

function isTerminalTaskStatus(status: unknown): boolean {
  const v = String(status ?? "").trim().toLowerCase();
  return v === "completed" || v === "failed" || v === "cancelled";
}

function pickActiveTask(tasks: any[]): any | null {
  const list = Array.isArray(tasks) ? tasks : [];
  return (
    list.find((t) => String(t?.status ?? "") === "running") ??
    list.find((t) => String(t?.status ?? "") === "blocked") ??
    list.find((t) => String(t?.status ?? "") === "pending") ??
    list[0] ??
    null
  );
}

function pickCurrentStep(task: any): any | null {
  const currentStepId = typeof task?.currentStepId === "string" ? task.currentStepId : "";
  const steps = Array.isArray(task?.steps) ? (task.steps as any[]) : [];
  if (!currentStepId) return null;
  return steps.find((s) => String(s?.id ?? "") === currentStepId) ?? null;
}

function pickLatestRunForStep(runs: any[], taskId: string, stepId: string): any | null {
  const list = Array.isArray(runs) ? runs : [];
  const candidates = list
    .filter((r) => String(r?.taskId ?? "") === taskId && String(r?.stepId ?? "") === stepId)
    .sort((a, b) => parseDate(b?.startedAt) - parseDate(a?.startedAt));
  return candidates[0] ?? null;
}

export async function getPmNextActionForIssue(
  deps: { prisma: PrismaDeps },
  issueId: string,
): Promise<
  | { success: true; data: { nextAction: PmNextAction } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const id = String(issueId ?? "").trim();
  if (!id) return { success: false, error: { code: "BAD_REQUEST", message: "issueId 不能为空" } };

  const issue = await deps.prisma.issue.findUnique({
    where: { id },
    include: { project: true } as any,
  });
  if (!issue) return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };

  const [tasks, runs] = await Promise.all([
    deps.prisma.task.findMany({
      where: { issueId: id },
      include: { steps: { orderBy: { order: "asc" } } } as any,
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    deps.prisma.run.findMany({
      where: { issueId: id },
      include: { step: true, task: true } as any,
      orderBy: { startedAt: "desc" },
      take: 20,
    }),
  ]);

  const pendingApproval = await deps.prisma.approval
    .findFirst({
      where: { status: "pending", run: { is: { issueId: id } } } as any,
      orderBy: { createdAt: "desc" } as any,
      include: { run: { include: { step: true, task: true, issue: true } } } as any,
    })
    .catch(() => null);

  if (pendingApproval && (pendingApproval as any).run) {
    const approvalRun = (pendingApproval as any).run as any;
    const summary = toApprovalSummary(pendingApproval as any, approvalRun);
    if (summary) {
      const approvalRunStatus = String(approvalRun.status ?? "unknown");
      const taskIdFromRun = typeof approvalRun.taskId === "string" ? String(approvalRun.taskId) : null;
      const stepFromRun = approvalRun?.step
        ? {
            id: String(approvalRun.step.id ?? ""),
            key: String(approvalRun.step.key ?? ""),
            kind: String(approvalRun.step.kind ?? ""),
            status: String(approvalRun.step.status ?? ""),
            executorType: String(approvalRun.step.executorType ?? ""),
          }
        : null;

      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action: "approve_action",
            reason: `存在待审批动作：${summary.action}`,
            source: "approval",
            taskId: taskIdFromRun,
            step: stepFromRun,
            run: { id: summary.runId, status: approvalRunStatus },
            approval: summary,
          },
        },
      };
    }
  }

  const task = pickActiveTask(tasks as any[]);
  if (task && !isTerminalTaskStatus((task as any).status)) {
    const step = pickCurrentStep(task);
    const stepId = step ? String(step.id ?? "") : "";
    const taskId = String((task as any).id ?? "");
    const runForStep = stepId ? pickLatestRunForStep(runs as any[], taskId, stepId) : null;

    const stepStatus = String(step?.status ?? "");
    const executorType = String(step?.executorType ?? "");
    const stepKind = String(step?.kind ?? "");

    if (String((task as any).status) === "blocked" || stepStatus === "blocked") {
      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action: "handle_blocked_task",
            reason: "Task 已被打回/阻塞：请根据评审意见修复，必要时回滚到指定 Step 或进行重规划（correct-course）",
            source: "task",
            taskId,
            step: step
              ? { id: stepId, key: String(step.key ?? ""), kind: stepKind, status: stepStatus, executorType }
              : null,
            run: runForStep ? { id: String(runForStep.id ?? ""), status: String(runForStep.status ?? "") } : null,
            approval: null,
          },
        },
      };
    }

    if (stepStatus === "waiting_ci") {
      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action: "wait_ci",
            reason: "当前步骤正在等待 CI/测试结果回写",
            source: "task",
            taskId,
            step: step
              ? { id: stepId, key: String(step.key ?? ""), kind: stepKind, status: stepStatus, executorType }
              : null,
            run: runForStep ? { id: String(runForStep.id ?? ""), status: String(runForStep.status ?? "") } : null,
            approval: null,
          },
        },
      };
    }

    if (stepStatus === "waiting_human") {
      const action = executorType === "human" ? "submit_human_step" : "check_approvals";
      const reason =
        executorType === "human"
          ? `当前步骤需要人工处理：${stepKind || "unknown"}`
          : `当前步骤需要人工确认/审批（通常是受控动作）：${stepKind || "unknown"}`;

      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action,
            reason,
            source: "task",
            taskId,
            step: step
              ? { id: stepId, key: String(step.key ?? ""), kind: stepKind, status: stepStatus, executorType }
              : null,
            run: runForStep ? { id: String(runForStep.id ?? ""), status: String(runForStep.status ?? "") } : null,
            approval: null,
          },
        },
      };
    }

    if (stepStatus === "ready") {
      const action = executorType === "human" ? "start_human_step" : "start_step";
      const reason = executorType === "human" ? `当前步骤已就绪，等待人工开始/提交：${stepKind}` : `当前步骤已就绪，可启动执行：${stepKind}`;

      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action,
            reason,
            source: "task",
            taskId,
            step: step
              ? { id: stepId, key: String(step.key ?? ""), kind: stepKind, status: stepStatus, executorType }
              : null,
            run: runForStep ? { id: String(runForStep.id ?? ""), status: String(runForStep.status ?? "") } : null,
            approval: null,
          },
        },
      };
    }

    if (stepStatus === "running") {
      return {
        success: true,
        data: {
          nextAction: {
            issueId: id,
            action: "wait_running",
            reason: `当前步骤执行中：${stepKind || "unknown"}`,
            source: "task",
            taskId,
            step: step
              ? { id: stepId, key: String(step.key ?? ""), kind: stepKind, status: stepStatus, executorType }
              : null,
            run: runForStep ? { id: String(runForStep.id ?? ""), status: String(runForStep.status ?? "") } : null,
            approval: null,
          },
        },
      };
    }
  }

  if (String((issue as any).status) === "pending") {
    return {
      success: true,
      data: {
        nextAction: {
          issueId: id,
          action: "pm_dispatch",
          reason: "Issue 仍在需求池（pending）：可由 PM 分析并分配/启动（或等待自动化）",
          source: "issue",
          taskId: null,
          step: null,
          run: null,
          approval: null,
        },
      },
    };
  }

  const autoReview = await deps.prisma.event
    .findFirst({
      where: { type: "pm.auto_review.reported", run: { is: { issueId: id } } } as any,
      orderBy: { timestamp: "desc" } as any,
      select: { payload: true } as any,
    })
    .catch(() => null);

  const payload = autoReview?.payload as any;
  const recommendation = payload && typeof payload === "object" ? (payload as any).recommendation : null;
  const action = typeof recommendation?.nextAction === "string" ? recommendation.nextAction.trim() : "";
  const reason = typeof recommendation?.reason === "string" ? recommendation.reason.trim() : "";

  if (action || reason) {
    return {
      success: true,
      data: {
        nextAction: {
          issueId: id,
          action: action || "none",
          reason: reason || "auto-review 未给出原因",
          source: "auto_review",
          taskId: null,
          step: null,
          run: null,
          approval: null,
        },
      },
    };
  }

  return {
    success: true,
    data: {
      nextAction: {
        issueId: id,
        action: "none",
        reason: "暂无可自动推断的下一步（可能需要创建 Task、补充信息或人工决策）",
        source: "fallback",
        taskId: null,
        step: null,
        run: null,
        approval: null,
      },
    },
  };
}
