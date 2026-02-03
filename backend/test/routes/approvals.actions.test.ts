import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpServer } from "../test-utils.js";

vi.mock("../../src/modules/artifacts/artifactPublish.js", () => ({ publishArtifact: vi.fn() }));
vi.mock("../../src/modules/scm/githubIssueComments.js", () => ({
  postGitHubApprovalCommentBestEffort: vi.fn(),
  postGitHubPrCreatedCommentBestEffort: vi.fn(),
}));
vi.mock("../../src/modules/workflow/taskProgress.js", () => ({ advanceTaskFromRunTerminal: vi.fn() }));
vi.mock("../../src/modules/workflow/taskAutoAdvance.js", () => ({ triggerTaskAutoAdvance: vi.fn() }));

const { makeApprovalRoutes } = await import("../../src/routes/approvals.js");
const { publishArtifact } = await import("../../src/modules/artifacts/artifactPublish.js");
const { postGitHubApprovalCommentBestEffort } = await import("../../src/modules/scm/githubIssueComments.js");

describe("Approvals routes (actions)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/approvals/:id/approve supports create_pr success", async () => {
    const server = createHttpServer();

    const approvalId = "00000000-0000-0000-0000-000000000001";
    const runId = "r1";

    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      approval: {
        findUnique: vi.fn().mockResolvedValue({
          id: approvalId,
          runId,
          action: "create_pr",
          status: "pending",
          payload: { title: "PR title", description: "desc", targetBranch: "main" },
          createdAt: new Date("2026-01-25T00:00:00.000Z"),
          requestedAt: new Date("2026-01-25T00:00:00.000Z"),
        }),
        update: vi.fn().mockResolvedValue({
          id: approvalId,
          runId,
          action: "create_pr",
          status: "executed",
          createdAt: new Date("2026-01-25T00:00:00.000Z"),
          requestedAt: new Date("2026-01-25T00:00:00.000Z"),
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: runId,
          issueId: "i1",
          taskId: null,
          stepId: null,
          branchName: "run/r1",
          workspacePath: "D:\\tmp",
          agent: {
            id: "a1",
            capabilities: { sandbox: { gitPush: true } },
          },
          issue: {
            id: "i1",
            projectId: "p1",
            externalProvider: "github",
            externalNumber: 7,
            project: {
              id: "p1",
              name: "P",
              scmType: "gitlab",
              repoUrl: "https://gitlab.example.com/group/repo.git",
              defaultBranch: "main",
              runGitCredentialId: "c-run",
              scmAdminCredentialId: "c-admin",
              githubAccessToken: "gh",
            },
          },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      projectScmConfig: { findUnique: vi.fn().mockResolvedValue({ projectId: "p1", gitlabProjectId: 123 }) },
      gitCredential: {
        findMany: vi.fn().mockResolvedValue([
          { id: "c-run", projectId: "p1", gitAuthMode: "https_pat" },
          { id: "c-admin", projectId: "p1", gitlabAccessToken: "gl", gitAuthMode: "https_pat" },
        ]),
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
      artifact: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;

    const createMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "opened",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main",
    });

    await server.register(
      makeApprovalRoutes({
        prisma,
        sandboxGitPush: vi.fn().mockResolvedValue(undefined),
        gitlab: { inferBaseUrl: () => "https://gitlab.example.com", createMergeRequest },
      }),
      { prefix: "/api/approvals" },
    );

    const res = await server.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      payload: { actor: "reviewer" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    expect(createMergeRequest).toHaveBeenCalled();
    expect(prisma.approval.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: approvalId } }));
    expect(postGitHubApprovalCommentBestEffort).toHaveBeenCalledWith(expect.objectContaining({ kind: "create_pr_approved" }));
    expect(postGitHubApprovalCommentBestEffort).toHaveBeenCalledWith(expect.objectContaining({ kind: "create_pr_executed" }));
    await server.close();
  });

  it("POST /api/approvals/:id/approve supports publish_artifact (bad payload)", async () => {
    const server = createHttpServer();

    const approvalId = "00000000-0000-0000-0000-000000000002";
    const runId = "r1";

    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      approval: {
        findUnique: vi.fn().mockResolvedValue({
          id: approvalId,
          runId,
          action: "publish_artifact",
          status: "pending",
          payload: {},
        }),
        update: vi.fn(),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: runId,
          issueId: "i1",
          issue: { id: "i1", projectId: "p1", project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" } },
          artifacts: [],
        }),
      },
    } as any;

    await server.register(makeApprovalRoutes({ prisma }), { prefix: "/api/approvals" });

    const res = await server.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, payload: { actor: "u" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe("BAD_PAYLOAD");
    expect(publishArtifact).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/approvals/:id/approve supports publish_artifact success", async () => {
    const server = createHttpServer();

    const approvalId = "00000000-0000-0000-0000-000000000003";
    const runId = "r1";

    (publishArtifact as any).mockResolvedValueOnce({ success: true, data: { path: "docs/out.md", commitSha: "sha1" } });

    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      approval: {
        findUnique: vi.fn().mockResolvedValue({
          id: approvalId,
          runId,
          action: "publish_artifact",
          status: "pending",
          payload: { sourceArtifactId: "art-1", path: "docs/out.md" },
        }),
        update: vi.fn().mockResolvedValue({
          id: approvalId,
          runId,
          action: "publish_artifact",
          status: "executed",
          createdAt: new Date("2026-01-25T00:00:00.000Z"),
        }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: runId,
          issueId: "i1",
          taskId: null,
          stepId: null,
          issue: {
            id: "i1",
            projectId: "p1",
            externalProvider: "github",
            externalNumber: 7,
            project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" },
          },
          artifacts: [],
        }),
      },
    } as any;

    await server.register(makeApprovalRoutes({ prisma }), { prefix: "/api/approvals" });

    const res = await server.inject({ method: "POST", url: `/api/approvals/${approvalId}/approve`, payload: { actor: "u" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.commitSha).toBe("sha1");
    expect(publishArtifact).toHaveBeenCalledWith({ prisma }, "art-1", { path: "docs/out.md" });
    await server.close();
  });

  it("POST /api/approvals/:id/reject blocks task/step when action is not merge_pr", async () => {
    const server = createHttpServer();

    const approvalId = "00000000-0000-0000-0000-000000000004";
    const runId = "r1";

    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      approval: {
        findUnique: vi.fn().mockResolvedValue({ id: approvalId, runId, action: "create_pr", status: "pending" }),
        update: vi.fn().mockResolvedValue({ id: approvalId, runId, action: "create_pr", status: "rejected", reason: "no" }),
      },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: runId,
          issueId: "i1",
          taskId: "t1",
          stepId: "s1",
          scmPrUrl: "https://x/pr/1",
          issue: {
            id: "i1",
            projectId: "p1",
            externalProvider: "github",
            externalNumber: 7,
            project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" },
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      task: { update: vi.fn().mockResolvedValue({}) },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const broadcastToClients = vi.fn();

    await server.register(makeApprovalRoutes({ prisma, broadcastToClients }), { prefix: "/api/approvals" });

    const res = await server.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/reject`,
      payload: { actor: "u", reason: "no" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(prisma.step.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "blocked" } });
    expect(prisma.task.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "blocked" } });
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "reviewing" } });
    expect(broadcastToClients).toHaveBeenCalledWith(expect.objectContaining({ reason: "approval_rejected" }));
    expect(postGitHubApprovalCommentBestEffort).toHaveBeenCalledWith(expect.objectContaining({ kind: "create_pr_rejected" }));
    await server.close();
  });
});
