import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { autoAdvanceTaskOnce } from "../../src/modules/workflow/taskAutoAdvance.js";

describe("Task auto advance", () => {
  const original = {
    PM_AUTOMATION_ENABLED: process.env.PM_AUTOMATION_ENABLED,
  };

  beforeEach(() => {
    process.env.PM_AUTOMATION_ENABLED = "1";
  });

  afterAll(() => {
    if (typeof original.PM_AUTOMATION_ENABLED === "string") process.env.PM_AUTOMATION_ENABLED = original.PM_AUTOMATION_ENABLED;
    else delete process.env.PM_AUTOMATION_ENABLED;
  });

  it("starts ready system step and dispatches execution", async () => {
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          status: "running",
          currentStepId: "s1",
          workspacePath: "D:\\repo\\.worktrees\\t1",
          branchName: "run/t1",
          steps: [{ id: "s1", kind: "pr.create", status: "ready", executorType: "system" }],
          issue: {
            id: "i1",
            project: {
              branchProtection: {
                pmPolicy: {
                  version: 1,
                  automation: {
                    autoStartIssue: true,
                    autoReview: true,
                    autoCreatePr: true,
                    autoRequestMergeApproval: true,
                  },
                  approvals: { requireForActions: ["merge_pr"] },
                  sensitivePaths: [],
                },
              },
            },
          },
        }),
      },
      event: {
        create: vi.fn().mockResolvedValue({ id: "e1" }),
      },
    } as any;

    const startStep = vi.fn().mockResolvedValue({ task: { id: "t1" }, step: { id: "s1" }, run: { id: "r1" } });
    const dispatchExecutionForRun = vi.fn().mockResolvedValue({ success: true });
    const broadcastToClients = vi.fn();

    await autoAdvanceTaskOnce(
      { prisma, startStep, dispatchExecutionForRun, broadcastToClients },
      { issueId: "i1", taskId: "t1", trigger: "step_completed" },
    );

    expect(startStep).toHaveBeenCalledWith({ prisma }, "s1", {});
    expect(dispatchExecutionForRun).toHaveBeenCalledWith(expect.any(Object), "r1");
    expect(broadcastToClients).toHaveBeenCalledWith({
      type: "task_updated",
      issue_id: "i1",
      task_id: "t1",
      step_id: "s1",
      run_id: "r1",
    });
    expect(prisma.event.create).toHaveBeenCalled();
  });

  it("skips pr.create when policy disables autoCreatePr", async () => {
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          status: "running",
          currentStepId: "s1",
          workspacePath: "D:\\repo\\.worktrees\\t1",
          branchName: "run/t1",
          steps: [{ id: "s1", kind: "pr.create", status: "ready", executorType: "system" }],
          issue: {
            id: "i1",
            project: {
              branchProtection: {
                pmPolicy: {
                  version: 1,
                  automation: {
                    autoStartIssue: true,
                    autoReview: true,
                    autoCreatePr: false,
                    autoRequestMergeApproval: true,
                  },
                  approvals: { requireForActions: ["merge_pr"] },
                  sensitivePaths: [],
                },
              },
            },
          },
        }),
      },
      event: {
        create: vi.fn(),
      },
    } as any;

    const startStep = vi.fn();
    const dispatchExecutionForRun = vi.fn();

    await autoAdvanceTaskOnce(
      { prisma, startStep, dispatchExecutionForRun },
      { issueId: "i1", taskId: "t1", trigger: "step_completed" },
    );

    expect(startStep).not.toHaveBeenCalled();
    expect(dispatchExecutionForRun).not.toHaveBeenCalled();
  });

  it("skips agent step when sendToAgent is missing", async () => {
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          status: "running",
          currentStepId: "s1",
          workspacePath: "D:\\repo\\.worktrees\\t1",
          branchName: "run/t1",
          steps: [{ id: "s1", kind: "dev.implement", status: "ready", executorType: "agent" }],
          issue: { id: "i1", project: { branchProtection: null } },
        }),
      },
      event: {
        create: vi.fn(),
      },
    } as any;

    const startStep = vi.fn();
    const dispatchExecutionForRun = vi.fn();

    await autoAdvanceTaskOnce(
      { prisma, startStep, dispatchExecutionForRun },
      { issueId: "i1", taskId: "t1", trigger: "step_completed" },
    );

    expect(startStep).not.toHaveBeenCalled();
    expect(dispatchExecutionForRun).not.toHaveBeenCalled();
  });

  it("skips non-agent step when workspace is missing", async () => {
    const prisma = {
      task: {
        findUnique: vi.fn().mockResolvedValue({
          id: "t1",
          issueId: "i1",
          status: "running",
          currentStepId: "s1",
          workspacePath: null,
          branchName: null,
          steps: [{ id: "s1", kind: "pr.create", status: "ready", executorType: "system" }],
          issue: { id: "i1", project: { branchProtection: null } },
        }),
      },
      event: {
        create: vi.fn(),
      },
    } as any;

    const startStep = vi.fn();
    const dispatchExecutionForRun = vi.fn();

    await autoAdvanceTaskOnce(
      { prisma, startStep, dispatchExecutionForRun },
      { issueId: "i1", taskId: "t1", trigger: "step_completed" },
    );

    expect(startStep).not.toHaveBeenCalled();
    expect(dispatchExecutionForRun).not.toHaveBeenCalled();
  });
});

