import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/uuid.js", () => ({ uuidv7: () => "uuid-1" }));
vi.mock("../../src/services/githubIssueComments.js", () => ({ postGitHubApprovalCommentBestEffort: vi.fn() }));

const { postGitHubApprovalCommentBestEffort } = await import("../../src/services/githubIssueComments.js");
const {
  requestCreatePrApproval,
  requestMergePrApproval,
  requestPublishArtifactApproval,
  toApprovalSummary,
} = await import("../../src/services/approvalRequests.js");

describe("approvalRequests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("toApprovalSummary returns null when action/status invalid", () => {
    expect(toApprovalSummary(null)).toBeNull();
    expect(toApprovalSummary({ id: "a1", runId: "r1", action: "bad", status: "pending", createdAt: new Date() })).toBeNull();
    expect(toApprovalSummary({ id: "a1", runId: "r1", action: "merge_pr", status: "bad", createdAt: new Date() })).toBeNull();
  });

  it("toApprovalSummary extracts issue/project info", () => {
    const summary = toApprovalSummary(
      { id: "a1", runId: "r1", action: "merge_pr", status: "pending", createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { issue: { id: "i1", title: "t1", projectId: "p1" } },
    );
    expect(summary).toMatchObject({ id: "a1", runId: "r1", action: "merge_pr", status: "pending", issueId: "i1", projectId: "p1" });
  });

  it("requestMergePrApproval returns NOT_FOUND when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await requestMergePrApproval({ prisma, runId: "r1" });
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } });
  });

  it("requestMergePrApproval returns NO_PR when pr url missing", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", scmPrUrl: null, artifacts: [], issue: { project: {} } }) },
    } as any;
    const res = await requestMergePrApproval({ prisma, runId: "r1" });
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NO_PR");
  });

  it("requestMergePrApproval returns existing pending approval when present", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          scmPrUrl: "https://x/pr/1",
          issue: { id: "i1", title: "t", projectId: "p1", externalProvider: "github", externalNumber: 1, project: {} },
          artifacts: [],
        }),
      },
      approval: {
        findFirst: vi.fn().mockResolvedValue({
          id: "a1",
          runId: "r1",
          action: "merge_pr",
          status: "pending",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      },
    } as any;

    const res = await requestMergePrApproval({ prisma, runId: "r1" });
    expect(res.success).toBe(true);
    expect((res as any).data.approval.id).toBe("a1");
  });

  it("requestMergePrApproval creates approval + event and posts GitHub comment (best-effort)", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          scmPrUrl: "https://github.com/o/r/pull/1",
          issue: {
            id: "i1",
            title: "t",
            projectId: "p1",
            externalProvider: "github",
            externalNumber: 7,
            project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" },
          },
          artifacts: [],
        }),
      },
      approval: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "a-new",
          runId: "r1",
          action: "merge_pr",
          status: "pending",
          requestedBy: "user",
          requestedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const res = await requestMergePrApproval({ prisma, runId: "r1", payload: { squash: true } });
    expect(res.success).toBe(true);
    expect(prisma.approval.create).toHaveBeenCalled();
    expect(prisma.event.create).toHaveBeenCalled();
    expect(postGitHubApprovalCommentBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "merge_pr_requested", approvalId: "a-new", runId: "r1", prUrl: "https://github.com/o/r/pull/1" }),
    );
  });

  it("requestCreatePrApproval returns NOT_FOUND when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await requestCreatePrApproval({ prisma, runId: "r1" });
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NOT_FOUND");
  });

  it("requestPublishArtifactApproval returns NO_RUN when artifact not bound to run", async () => {
    const prisma = {
      artifact: { findUnique: vi.fn().mockResolvedValue({ id: "a1", run: null }) },
    } as any;
    const res = await requestPublishArtifactApproval({ prisma, artifactId: "a1" });
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NO_RUN");
  });
});

