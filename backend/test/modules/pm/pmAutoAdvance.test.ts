import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { flushMicrotasks } from "../../test-utils.js";

vi.mock("../../../src/modules/scm/runReviewRequest.js", () => ({
  createReviewRequestForRun: vi.fn(),
}));
vi.mock("../../../src/modules/approvals/approvalRequests.js", () => ({
  requestCreatePrApproval: vi.fn(),
  requestMergePrApproval: vi.fn(),
}));
vi.mock("../../../src/modules/pm/pmAutoReviewRun.js", () => ({
  autoReviewRunForPm: vi.fn(),
}));
vi.mock("../../../src/modules/pm/pmPolicy.js", () => ({
  getPmPolicyFromBranchProtection: vi.fn(() => ({
    policy: {
      automation: { autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
      approvals: { requireForActions: [] as string[] },
    },
  })),
}));

const { triggerPmAutoAdvance } = await import("../../../src/modules/pm/pmAutoAdvance.js");
const { createReviewRequestForRun } = await import("../../../src/modules/scm/runReviewRequest.js");
const { requestCreatePrApproval, requestMergePrApproval } = await import(
  "../../../src/modules/approvals/approvalRequests.js",
);
const { autoReviewRunForPm } = await import("../../../src/modules/pm/pmAutoReviewRun.js");
const { getPmPolicyFromBranchProtection } = await import("../../../src/modules/pm/pmPolicy.js");
const { isPmAutomationEnabled } = await import("../../../src/modules/pm/pmLlm.js");

const originalAutomationEnv = process.env.PM_AUTOMATION_ENABLED;

beforeEach(() => {
  (autoReviewRunForPm as any).mockResolvedValue({ success: true });
  (requestMergePrApproval as any).mockResolvedValue({ success: true });
  (requestCreatePrApproval as any).mockResolvedValue({ success: true, data: { approval: { id: "a1" } } });
});

afterEach(() => {
  process.env.PM_AUTOMATION_ENABLED = originalAutomationEnv;
  vi.clearAllMocks();
});

describe("pmAutoAdvance", () => {
  it("skips when automation disabled", async () => {
    process.env.PM_AUTOMATION_ENABLED = "0";
    const prisma = { run: { findUnique: vi.fn() } } as any;
    triggerPmAutoAdvance({ prisma }, { runId: "r1", issueId: "i1", trigger: "run_completed" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(prisma.run.findUnique).not.toHaveBeenCalled();
  });

  it("auto creates PR on run_completed", async () => {
    process.env.PM_AUTOMATION_ENABLED = "1";
    expect(isPmAutomationEnabled()).toBe(true);
    (createReviewRequestForRun as any).mockResolvedValue({ success: true });
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issue: { project: { branchProtection: {}, repoUrl: "https://x", scmType: "github" } },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    triggerPmAutoAdvance({ prisma }, { runId: "r1", issueId: "i1", trigger: "run_completed" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(prisma.run.findUnique).toHaveBeenCalled();
    expect(autoReviewRunForPm).toHaveBeenCalled();
    expect(createReviewRequestForRun).toHaveBeenCalled();
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "pm.pr.auto_created" }) }),
    );
  });

  it("requests approval when policy requires create_pr", async () => {
    process.env.PM_AUTOMATION_ENABLED = "1";
    expect(isPmAutomationEnabled()).toBe(true);
    (getPmPolicyFromBranchProtection as any).mockReturnValue({
      policy: {
        automation: { autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
        approvals: { requireForActions: ["create_pr"] },
      },
    });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r2",
          issue: { project: { branchProtection: {} } },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    triggerPmAutoAdvance({ prisma }, { runId: "r2", issueId: "i2", trigger: "run_completed" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(prisma.run.findUnique).toHaveBeenCalled();
    expect(autoReviewRunForPm).toHaveBeenCalled();
    expect(requestCreatePrApproval).toHaveBeenCalled();
    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "pm.pr.auto_create.approval_requested" }),
      }),
    );
  });

  it("requests merge approval on ci_completed", async () => {
    process.env.PM_AUTOMATION_ENABLED = "1";
    expect(isPmAutomationEnabled()).toBe(true);
    (getPmPolicyFromBranchProtection as any).mockReturnValue({
      policy: {
        automation: { autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
        approvals: { requireForActions: ["merge_pr"] },
      },
    });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r3",
          scmPrUrl: "https://x",
          scmCiStatus: "passed",
          issue: { project: { branchProtection: {} } },
        }),
      },
    } as any;

    triggerPmAutoAdvance({ prisma }, { runId: "r3", issueId: "i3", trigger: "ci_completed" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(prisma.run.findUnique).toHaveBeenCalled();
    expect(autoReviewRunForPm).toHaveBeenCalled();
    expect(requestMergePrApproval).toHaveBeenCalled();
  });
});
