import { describe, expect, it, vi } from "vitest";

import { autoReviewRunForPm } from "../../src/services/pm/pmAutoReviewRun.js";

describe("PM auto-review run", () => {
  it("uses run scope (non-task) and recommends none when no changes", async () => {
    const findFirstCalls: any[] = [];
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          issue: {
            id: "i1",
            project: { id: "p1", defaultBranch: "main", branchProtection: null },
          },
          artifacts: [],
        }),
      },
      artifact: {
        findFirst: vi.fn().mockImplementation(async (args: any) => {
          findFirstCalls.push(args);
          return null;
        }),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
    } as any;

    const res = await autoReviewRunForPm(
      { prisma },
      "r1",
      {
        getChanges: vi.fn().mockResolvedValue({ baseBranch: "main", branch: "run/t1-r1", files: [] }),
      },
    );

    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("none");

    expect(findFirstCalls).toHaveLength(2);
    for (const call of findFirstCalls) {
      expect(call.where.run.is).toEqual({ id: "r1" });
    }
  });

  it("recommends manual_review when diff fails and no PR exists", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          issue: {
            id: "i1",
            project: { id: "p1", defaultBranch: "main", branchProtection: null },
          },
          artifacts: [],
        }),
      },
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
    } as any;

    const res = await autoReviewRunForPm(
      { prisma },
      "r1",
      {
        getChanges: vi.fn().mockRejectedValue(new Error("diff failed")),
      },
    );

    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("manual_review");
    expect(String((res as any).data.report.recommendation.reason)).toContain("diff failed");
  });

  it("recommends create_pr when changes exist but no PR exists", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          taskId: null,
          issueId: "i1",
          branchName: "run/t1-r1",
          issue: {
            id: "i1",
            project: { id: "p1", defaultBranch: "main", branchProtection: null },
          },
          artifacts: [],
        }),
      },
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
      },
    } as any;

    const res = await autoReviewRunForPm(
      { prisma },
      "r1",
      {
        getChanges: vi.fn().mockResolvedValue({
          baseBranch: "main",
          branch: "run/t1-r1",
          files: [{ path: "backend/src/index.ts", status: "M" }],
        }),
      },
    );

    expect(res.success).toBe(true);
    expect((res as any).data.report.recommendation.nextAction).toBe("create_pr");
  });
});

