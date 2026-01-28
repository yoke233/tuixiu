import { describe, expect, it, vi } from "vitest";

import { advanceTaskFromRunTerminal, setTaskBlockedFromRun } from "../../src/services/taskProgress.js";

describe("taskProgress", () => {
  it("advanceTaskFromRunTerminal returns handled:false for legacy run", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", status: "running" }) },
      step: { update: vi.fn() },
      task: { update: vi.fn() },
      issue: { update: vi.fn() },
      event: { create: vi.fn() },
      artifact: { findFirst: vi.fn(), create: vi.fn() },
    } as any;

    const res = await advanceTaskFromRunTerminal({ prisma }, "r1", "completed");
    expect(res).toEqual({ handled: false });
    expect(prisma.step.update).not.toHaveBeenCalled();
  });

  it("advanceTaskFromRunTerminal marks failed and writes event when provided", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: "t1",
          stepId: "s1",
          executorType: "agent",
          task: { id: "t1", issueId: "i1", steps: [{ id: "s1", order: 1, kind: "dev.implement" }] },
          step: { id: "s1", order: 1, kind: "dev.implement" },
        }),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
      artifact: { findFirst: vi.fn(), create: vi.fn() },
    } as any;

    const res = await advanceTaskFromRunTerminal({ prisma }, "r1", "failed", { errorMessage: "boom" });
    expect(res.handled).toBe(true);
    expect(prisma.step.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" }, data: { status: "failed" } }));
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" }, data: { status: "failed" } }));
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1" }, data: { status: "failed" } }));
    expect(prisma.event.create).toHaveBeenCalled();
  });

  it("advanceTaskFromRunTerminal completes step and readies next", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: "t1",
          stepId: "s1",
          executorType: "human",
          task: {
            id: "t1",
            issueId: "i1",
            steps: [
              { id: "s1", order: 1, kind: "dev.implement", status: "running" },
              { id: "s2", order: 2, kind: "test.run", status: "pending" },
            ],
          },
          step: { id: "s1", order: 1, kind: "dev.implement" },
        }),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn() },
      artifact: { findFirst: vi.fn(), create: vi.fn() },
    } as any;

    const res = await advanceTaskFromRunTerminal({ prisma }, "r1", "completed");
    expect(res.handled).toBe(true);
    expect(prisma.step.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" }, data: { status: "completed" } }));
    expect(prisma.step.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s2" }, data: { status: "ready" } }));
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" }, data: { status: "running", currentStepId: "s2" } }));
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1" }, data: { status: "running" } }));
  });

  it("advanceTaskFromRunTerminal completes task and sets issue done for pr.merge", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: "t1",
          stepId: "s1",
          executorType: "human",
          task: { id: "t1", issueId: "i1", steps: [{ id: "s1", order: 1, kind: "pr.merge", status: "running" }] },
          step: { id: "s1", order: 1, kind: "pr.merge" },
        }),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn() },
      artifact: { findFirst: vi.fn(), create: vi.fn() },
    } as any;

    const res = await advanceTaskFromRunTerminal({ prisma }, "r1", "completed");
    expect(res.handled).toBe(true);
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "completed" } }));
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "done" } }));
  });

  it("advanceTaskFromRunTerminal extracts REPORT_JSON into report artifact for agent prd.generate", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: "t1",
          stepId: "s1",
          executorType: "agent",
          task: { id: "t1", issueId: "i1", steps: [{ id: "s1", order: 1, kind: "prd.generate", status: "running" }] },
          step: { id: "s1", order: 1, kind: "prd.generate" },
        }),
      },
      event: {
        findMany: vi.fn().mockResolvedValue([
          {
            source: "acp",
            timestamp: "2026-01-01T00:00:00.000Z",
            payload: {
              type: "session_update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "hello\n```REPORT_JSON\n{\"kind\":\"prd\",\"title\":\"T\",\"markdown\":\"M\",\"acceptanceCriteria\":[\"a\"]}\n```\n",
                },
              },
            },
          },
        ]),
        create: vi.fn().mockResolvedValue({}),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    await advanceTaskFromRunTerminal({ prisma }, "r1", "completed");
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: "r1",
          type: "agent.report",
          payload: expect.objectContaining({ kind: "prd", title: "T" }),
        }),
      }),
    );
  });

  it("setTaskBlockedFromRun sets task blocked and issue reviewing", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: "t1",
          stepId: "s1",
          task: { id: "t1", issueId: "i1", steps: [] },
          step: { id: "s1", kind: "code.review" },
        }),
      },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const res = await setTaskBlockedFromRun({ prisma }, "r1", { code: "X", message: "m" });
    expect(res.handled).toBe(true);
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1" }, data: { status: "blocked" } }));
    expect(prisma.issue.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "i1" }, data: { status: "reviewing" } }));
    expect(prisma.event.create).toHaveBeenCalled();
  });
});
