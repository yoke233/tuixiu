import { describe, expect, it, vi } from "vitest";

import {
  renderGitHubApprovalComment,
  renderGitHubAutoReviewComment,
  renderGitHubIssueComment,
  renderGitHubPrCreatedComment,
} from "../../src/modules/scm/githubIssueComments.js";

describe("githubIssueComments templates", () => {
  it("renders issue comment via platform template", async () => {
    const prisma = {
      platformTextTemplate: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where?.key === "github.issueComment.assigned") return { template: "ASSIGNED {{agentName}} {{runId}}" };
          return null;
        }),
      },
    } as any;

    const body = await renderGitHubIssueComment({
      prisma,
      projectId: "p1",
      kind: "assigned",
      agentName: "alice",
      roleKey: null,
      runId: "r1",
    });

    expect(body).toBe("ASSIGNED alice r1");
  });

  it("renders approval comment via platform template", async () => {
    const prisma = {
      platformTextTemplate: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where?.key === "github.approvalComment.merge_pr_requested") return { template: "MERGE {{runId}} {{#if prUrl}}PR={{prUrl}}{{/if}}" };
          return null;
        }),
      },
    } as any;

    const body = await renderGitHubApprovalComment({
      prisma,
      projectId: "p1",
      kind: "merge_pr_requested",
      runId: "r1",
      approvalId: "a1",
      actor: "bob",
      prUrl: "https://x/pr/1",
    });

    expect(body).toBe("MERGE r1 PR=https://x/pr/1");
  });

  it("renders pr created comment via platform template", async () => {
    const prisma = {
      platformTextTemplate: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where?.key === "github.prCreatedComment") return { template: "PR {{providerLabel}} {{sourceBranch}}->{{targetBranch}}" };
          return null;
        }),
      },
    } as any;

    const body = await renderGitHubPrCreatedComment({
      prisma,
      projectId: "p1",
      runId: "r1",
      prUrl: "https://x/pr/1",
      provider: "gitlab",
      sourceBranch: "feat",
      targetBranch: "main",
    });

    expect(body).toBe("PR GitLab feat->main");
  });

  it("renders auto review comment via platform template", async () => {
    const prisma = {
      platformTextTemplate: {
        findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
          if (where?.key === "github.autoReviewComment") return { template: "CI={{ciText}} next={{nextAction}}" };
          return null;
        }),
      },
    } as any;

    const body = await renderGitHubAutoReviewComment({
      prisma,
      projectId: "p1",
      runId: "r1",
      prUrl: null,
      changedFiles: 0,
      ciPassed: true,
      sensitiveHits: 0,
      nextAction: "wait_ci",
      reason: null,
    });

    expect(body).toBe("CI=✅ 通过 next=wait_ci");
  });
});
