import { describe, expect, it, vi } from "vitest";

import { makeApprovalRoutes } from "../../src/routes/approvals.js";
import { createHttpServer } from "../test-utils.js";

describe("Approvals routes", () => {
  it("GET /api/approvals lists approval requests", async () => {
    const server = createHttpServer();
    const prisma = {
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", runId: "r1", type: "report", content: { kind: "approval_request", action: "merge_pr", status: "pending" }, createdAt: "2026-01-25T00:00:00.000Z", run: { issue: { id: "i1", title: "t1", projectId: "p1" } } },
          { id: "x1", runId: "r1", type: "report", content: { kind: "pm_analysis", analysis: { risk: "low" } }, createdAt: "2026-01-25T00:00:00.000Z", run: { issue: { id: "i1", title: "t1", projectId: "p1" } } },
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
      artifact: {
        findUnique: vi.fn().mockImplementation(async (args: any) => ({
          id: args.where.id,
          runId: "r1",
          type: "report",
          content: { kind: "approval_request", action: "merge_pr", status: "pending", payload: { squash: true } },
          createdAt: "2026-01-25T00:00:00.000Z",
        })),
        update: vi.fn().mockImplementation(async (args: any) => {
          if (args.where.id === "pr-1") {
            return { id: "pr-1", runId: "r1", type: "pr", content: args.data.content, createdAt: "2026-01-25T00:00:00.000Z" };
          }
          return { id: args.where.id, runId: "r1", type: "report", content: args.data.content, createdAt: "2026-01-25T00:00:00.000Z" };
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
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
          artifacts: [{ id: "pr-1", type: "pr", content: { iid: 7 } }],
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
    expect(prisma.artifact.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: approvalId } }));
    await server.close();
  });
});
