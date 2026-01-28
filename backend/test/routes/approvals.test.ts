import { describe, expect, it, vi } from "vitest";

import { makeApprovalRoutes } from "../../src/routes/approvals.js";
import { createHttpServer } from "../test-utils.js";

describe("Approvals routes", () => {
  it("GET /api/approvals lists approval requests", async () => {
    const server = createHttpServer();
    const prisma = {
      approval: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", runId: "r1", action: "merge_pr", status: "pending", createdAt: new Date("2026-01-25T00:00:00.000Z"), run: { issue: { id: "i1", title: "t1", projectId: "p1" } } },
        ]),
      },
    } as any;

    await server.register(makeApprovalRoutes({ prisma }), { prefix: "/api/approvals" });

    const res = await server.inject({ method: "GET", url: "/api/approvals?status=pending&limit=50" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.approvals).toHaveLength(1);
    expect(body.data.approvals[0].id).toBe("a1");
    expect(body.data.approvals[0].action).toBe("merge_pr");
    await server.close();
  });

  it("POST /api/approvals/:id/approve executes merge", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      approval: {
        findUnique: vi.fn().mockImplementation(async (args: any) => ({
          id: args.where.id,
          runId: "r1",
          action: "merge_pr",
          status: "pending",
          payload: { squash: true },
          createdAt: new Date("2026-01-25T00:00:00.000Z"),
          requestedAt: new Date("2026-01-25T00:00:00.000Z"),
        })),
        update: vi.fn().mockResolvedValue({
          id: "a1",
          runId: "r1",
          action: "merge_pr",
          status: "executed",
          createdAt: new Date("2026-01-25T00:00:00.000Z"),
          requestedAt: new Date("2026-01-25T00:00:00.000Z"),
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrNumber: 7,
          scmPrUrl: "https://gitlab.example.com/group/repo/-/merge_requests/7",
          issue: {
            id: "i1",
            projectId: "p1",
            project: {
              repoUrl: "https://gitlab.example.com/group/repo.git",
              scmType: "gitlab",
              gitlabProjectId: 123,
              gitlabAccessToken: "tok",
            },
          },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const mergeMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "merged",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main",
    });
    const getMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "merged",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main",
    });

    await server.register(
      makeApprovalRoutes({
        prisma,
        gitlab: { inferBaseUrl: () => "https://gitlab.example.com", createMergeRequest: vi.fn(), mergeMergeRequest, getMergeRequest },
      }),
      { prefix: "/api/approvals" },
    );

    const approvalId = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, payload: { actor: "reviewer" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(mergeMergeRequest).toHaveBeenCalled();
    expect(getMergeRequest).toHaveBeenCalled();
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "done" } });
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "completed" } });
    expect(prisma.approval.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: approvalId } }));
    await server.close();
  });
});
