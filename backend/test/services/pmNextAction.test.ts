import { describe, expect, it, vi } from "vitest";

import { getPmNextActionForIssue } from "../../src/modules/pm/pmNextAction.js";

function makeBasePrisma(overrides?: Partial<any>) {
  const prisma = {
    issue: { findUnique: vi.fn() },
    task: { findMany: vi.fn() },
    run: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    approval: { findFirst: vi.fn() },
    event: { findFirst: vi.fn() },
    ...overrides,
  } as any;
  return prisma;
}

describe("pmNextAction", () => {
  it("returns BAD_REQUEST when issueId empty", async () => {
    const prisma = makeBasePrisma();
    const res = await getPmNextActionForIssue({ prisma }, "  ");
    expect(res).toEqual({ success: false, error: { code: "BAD_REQUEST", message: "issueId 不能为空" } });
  });

  it("returns NOT_FOUND when issue missing", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue(null);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } });
  });

  it("returns approval nextAction when pending approval exists", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.task.findMany.mockResolvedValue([]);
    prisma.run.findMany.mockResolvedValue([]);

    prisma.approval.findFirst.mockResolvedValue({
      id: "ap1",
      runId: "run1",
      action: "merge_pr",
      status: "pending",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      run: {
        id: "run1",
        status: "waiting_human",
        taskId: "t1",
        stepId: "s1",
        issueId: "i1",
        step: { id: "s1", key: "k1", kind: "system", status: "waiting_human", executorType: "system" },
      },
    });

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res.success).toBe(true);

    const nextAction = (res as any).data.nextAction;
    expect(nextAction.source).toBe("approval");
    expect(nextAction.action).toBe("approve_action");
    expect(nextAction.reason).toContain("merge_pr");
    expect(nextAction.taskId).toBe("t1");
    expect(nextAction.run).toEqual({ id: "run1", status: "waiting_human" });
    expect(nextAction.step).toEqual({ id: "s1", key: "k1", kind: "system", status: "waiting_human", executorType: "system" });
    expect(nextAction.approval).toEqual(
      expect.objectContaining({
        id: "ap1",
        runId: "run1",
        action: "merge_pr",
        status: "pending",
        issueId: "i1",
      }),
    );
  });

  it("returns task nextAction for blocked task", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      {
        id: "t1",
        status: "blocked",
        currentStepId: "s1",
        steps: [{ id: "s1", key: "step", kind: "code", status: "ready", executorType: "agent" }],
      },
    ]);
    prisma.run.findMany.mockResolvedValue([
      { id: "r1", taskId: "t1", stepId: "s1", startedAt: "2020-01-01T00:00:00Z", status: "running" },
    ]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "handle_blocked_task",
          reason: "Task 已被打回/阻塞：请根据评审意见修复，必要时回滚到指定 Step 或进行重规划（correct-course）",
          source: "task",
          taskId: "t1",
          step: { id: "s1", key: "step", kind: "code", status: "ready", executorType: "agent" },
          run: { id: "r1", status: "running" },
          approval: null,
        },
      },
    });
  });

  it("returns task nextAction for waiting_ci step", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      {
        id: "t1",
        status: "running",
        currentStepId: "s1",
        steps: [{ id: "s1", key: "step", kind: "code", status: "waiting_ci", executorType: "ci" }],
      },
    ]);
    prisma.run.findMany.mockResolvedValue([]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "wait_ci",
          reason: "当前步骤正在等待 CI/测试结果回写",
          source: "task",
          taskId: "t1",
          step: { id: "s1", key: "step", kind: "code", status: "waiting_ci", executorType: "ci" },
          run: null,
          approval: null,
        },
      },
    });
  });

  it("returns task nextAction for waiting_human step", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      {
        id: "t1",
        status: "running",
        currentStepId: "s1",
        steps: [{ id: "s1", key: "step", kind: "review", status: "waiting_human", executorType: "human" }],
      },
    ]);
    prisma.run.findMany.mockResolvedValue([]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "submit_human_step",
          reason: "当前步骤需要人工处理：review",
          source: "task",
          taskId: "t1",
          step: { id: "s1", key: "step", kind: "review", status: "waiting_human", executorType: "human" },
          run: null,
          approval: null,
        },
      },
    });
  });

  it("returns task nextAction for ready step", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      {
        id: "t1",
        status: "running",
        currentStepId: "s1",
        steps: [{ id: "s1", key: "step", kind: "code", status: "ready", executorType: "agent" }],
      },
    ]);
    prisma.run.findMany.mockResolvedValue([]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "start_step",
          reason: "当前步骤已就绪，可启动执行：code",
          source: "task",
          taskId: "t1",
          step: { id: "s1", key: "step", kind: "code", status: "ready", executorType: "agent" },
          run: null,
          approval: null,
        },
      },
    });
  });

  it("returns task nextAction for running step", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([
      {
        id: "t1",
        status: "running",
        currentStepId: "s1",
        steps: [{ id: "s1", key: "step", kind: "code", status: "running", executorType: "agent" }],
      },
    ]);
    prisma.run.findMany.mockResolvedValue([]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "wait_running",
          reason: "当前步骤执行中：code",
          source: "task",
          taskId: "t1",
          step: { id: "s1", key: "step", kind: "code", status: "running", executorType: "agent" },
          run: null,
          approval: null,
        },
      },
    });
  });

  it("returns issue nextAction when issue status pending and no active task", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "pending" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([{ id: "t1", status: "completed" }]);
    prisma.run.findMany.mockResolvedValue([]);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "pm_dispatch",
          reason: "Issue 仍在需求池（pending）：可由 PM 分析并分配/启动（或等待自动化）",
          source: "issue",
          taskId: null,
          step: null,
          run: null,
          approval: null,
        },
      },
    });
  });

  it("returns auto_review nextAction when recommendation exists", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.run.findMany.mockResolvedValue([]);

    prisma.event.findFirst.mockResolvedValue({
      payload: { recommendation: { nextAction: "do_something", reason: "because" } },
    });

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "do_something",
          reason: "because",
          source: "auto_review",
          taskId: null,
          step: null,
          run: null,
          approval: null,
        },
      },
    });
  });

  it("falls back when no recommendation", async () => {
    const prisma = makeBasePrisma();
    prisma.issue.findUnique.mockResolvedValue({ id: "i1", status: "running" });
    prisma.approval.findFirst.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.run.findMany.mockResolvedValue([]);
    prisma.event.findFirst.mockResolvedValue(null);

    const res = await getPmNextActionForIssue({ prisma }, "i1");
    expect(res).toEqual({
      success: true,
      data: {
        nextAction: {
          issueId: "i1",
          action: "none",
          reason: "暂无可自动推断的下一步（可能需要创建 Task、补充信息或人工决策）",
          source: "fallback",
          taskId: null,
          step: null,
          run: null,
          approval: null,
        },
      },
    });
  });
});
