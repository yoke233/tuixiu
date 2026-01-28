import { describe, expect, it, vi } from "vitest";

import { autoReviewRunForPm } from "../../src/services/pm/pmAutoReviewRun.js";

describe("PM auto-review run", () => {
  it("recommends create_pr when no PR exists", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          scmPrUrl: null,
          scmCiStatus: null,
          issue: {
            id: "i1",
            externalProvider: null,
            externalNumber: null,
            project: { id: "p1", defaultBranch: "main", branchProtection: null, githubAccessToken: null, repoUrl: "x" },
          },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const res = await autoReviewRunForPm({ prisma }, "r1");
    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("create_pr");
    expect(prisma.event.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "pm.auto_review.reported" }) }));
  });

  it("recommends wait_ci when PR exists but CI is not passed", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          scmPrUrl: "https://github.com/o/r/pull/1",
          scmPrState: "open",
          scmCiStatus: "pending",
          issue: {
            id: "i1",
            externalProvider: null,
            externalNumber: null,
            project: { id: "p1", defaultBranch: "main", branchProtection: null, githubAccessToken: null, repoUrl: "x" },
          },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const res = await autoReviewRunForPm({ prisma }, "r1");
    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("wait_ci");
  });

  it("recommends request_merge_approval when PR exists and CI passed (default policy requires merge_pr)", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          scmPrUrl: "https://github.com/o/r/pull/1",
          scmPrState: "open",
          scmCiStatus: "passed",
          issue: {
            id: "i1",
            externalProvider: null,
            externalNumber: null,
            project: { id: "p1", defaultBranch: "main", branchProtection: null, githubAccessToken: null, repoUrl: "x" },
          },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const res = await autoReviewRunForPm({ prisma }, "r1");
    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("request_merge_approval");
  });
});

