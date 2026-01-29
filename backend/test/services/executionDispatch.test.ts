import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/executors/acpAgentExecutor.js", () => ({ startAcpAgentExecution: vi.fn() }));
vi.mock("../../src/executors/ciExecutor.js", () => ({ startCiExecution: vi.fn() }));
vi.mock("../../src/executors/humanExecutor.js", () => ({ startHumanExecution: vi.fn() }));
vi.mock("../../src/executors/systemExecutor.js", () => ({ startSystemExecution: vi.fn() }));
vi.mock("../../src/modules/workflow/taskProgress.js", () => ({ advanceTaskFromRunTerminal: vi.fn() }));
vi.mock("../../src/modules/workflow/taskAutoAdvance.js", () => ({ triggerTaskAutoAdvance: vi.fn() }));

const { dispatchExecutionForRun } = await import("../../src/modules/workflow/executionDispatch.js");
const { startAcpAgentExecution } = await import("../../src/executors/acpAgentExecutor.js");
const { startCiExecution } = await import("../../src/executors/ciExecutor.js");
const { startHumanExecution } = await import("../../src/executors/humanExecutor.js");
const { startSystemExecution } = await import("../../src/executors/systemExecutor.js");
const { advanceTaskFromRunTerminal } = await import("../../src/modules/workflow/taskProgress.js");
const { triggerTaskAutoAdvance } = await import("../../src/modules/workflow/taskAutoAdvance.js");

describe("executionDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await dispatchExecutionForRun({ prisma }, "r1");
    expect(res).toEqual({ success: false, error: "Run 不存在" });
  });

  it("dispatches agent executor when configured", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", executorType: "agent" }) },
    } as any;
    const acp = {} as any;

    const res = await dispatchExecutionForRun({ prisma, acp }, "r1");

    expect(res).toEqual({ success: true });
    expect(startAcpAgentExecution).toHaveBeenCalledWith({ prisma, acp, createWorkspace: undefined }, "r1");
  });

  it("dispatches human executor", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", executorType: "human" }) },
    } as any;

    const res = await dispatchExecutionForRun({ prisma }, "r1");

    expect(res).toEqual({ success: true });
    expect(startHumanExecution).toHaveBeenCalledWith({ prisma }, "r1");
  });

  it("dispatches ci executor", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", executorType: "ci" }) },
    } as any;

    const res = await dispatchExecutionForRun({ prisma }, "r1");

    expect(res).toEqual({ success: true });
    expect(startCiExecution).toHaveBeenCalledWith({ prisma }, "r1");
  });

  it("dispatches system executor and triggers auto-advance", async () => {
    (startSystemExecution as any).mockResolvedValueOnce({ executed: true });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          taskId: "t1",
          stepId: "s1",
          executorType: "system",
        }),
      },
    } as any;

    const broadcastToClients = vi.fn();
    const res = await dispatchExecutionForRun({ prisma, broadcastToClients }, "r1");

    expect(res).toEqual({ success: true });
    expect(startSystemExecution).toHaveBeenCalledWith({ prisma }, "r1");
    expect(broadcastToClients).toHaveBeenCalledWith({
      type: "task_updated",
      issue_id: "i1",
      task_id: "t1",
      step_id: "s1",
      run_id: "r1",
    });
    expect(triggerTaskAutoAdvance).toHaveBeenCalledWith(
      expect.objectContaining({ prisma, broadcastToClients }),
      { issueId: "i1", taskId: "t1", trigger: "step_completed" },
    );
  });

  it("fails when agent executor but acp not configured", async () => {
    (advanceTaskFromRunTerminal as any).mockResolvedValueOnce({ handled: false });

    const prisma = {
      run: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => ({
            id: "r1",
            issueId: "i1",
            taskId: "t1",
            stepId: "s1",
            executorType: "agent",
            agentId: "a1",
          }))
          .mockImplementation(async () => ({ agentId: "a1" })),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const res = await dispatchExecutionForRun({ prisma }, "r1");
    expect(res).toEqual({ success: false, error: "acpTunnel 未配置" });
  });

  it("updates run status and decreases agent load on executor error", async () => {
    (startHumanExecution as any).mockRejectedValueOnce(new Error("boom"));
    (advanceTaskFromRunTerminal as any).mockResolvedValueOnce({ handled: true });

    const prisma = {
      run: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(async () => ({
            id: "r1",
            issueId: "i1",
            taskId: "t1",
            stepId: "s1",
            executorType: "human",
            agentId: "a1",
          }))
          .mockImplementation(async () => ({ agentId: "a1" })),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const broadcastToClients = vi.fn();

    const res = await dispatchExecutionForRun({ prisma, broadcastToClients }, "r1");

    expect(res.success).toBe(false);
    expect(res.error).toBe("boom");

    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({
        status: "failed",
        failureReason: "executor_failed",
        errorMessage: "boom",
      }),
    });
    expect(advanceTaskFromRunTerminal).toHaveBeenCalledWith({ prisma }, "r1", "failed", { errorMessage: "boom" });
    expect(broadcastToClients).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "task_updated",
        issue_id: "i1",
        task_id: "t1",
        step_id: "s1",
        run_id: "r1",
        reason: "executor_failed",
      }),
    );

    expect(prisma.agent.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { currentLoad: { decrement: 1 } },
    });
  });
});
