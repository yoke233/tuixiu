import { describe, expect, it, vi } from "vitest";

import { startHumanExecution } from "../../src/executors/humanExecutor.js";

describe("humanExecutor", () => {
  it("throws when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(startHumanExecution({ prisma }, "r1")).rejects.toThrow("Run 不存在");
  });

  it("does nothing when taskId/stepId missing", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", taskId: null, stepId: null }) },
      event: { create: vi.fn() },
    } as any;

    await startHumanExecution({ prisma }, "r1");
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("creates human.action_required event when taskId/stepId exist (best effort)", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", taskId: "t1", stepId: "s1", step: { key: "k1" } }) },
      event: { create: vi.fn().mockRejectedValue(new Error("ignore")) },
    } as any;

    await startHumanExecution({ prisma }, "r1");
    expect(prisma.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: "r1",
        source: "system",
        type: "human.action_required",
        payload: { taskId: "t1", stepId: "s1", stepKey: "k1" },
      }),
    });
  });
});

