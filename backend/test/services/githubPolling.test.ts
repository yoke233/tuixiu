import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/taskEngine.js", () => {
  class TaskEngineError extends Error {
    code: string;
    details?: string;

    constructor(code: string, message: string, details?: string) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }

  return {
    TaskEngineError,
    createTaskFromTemplate: vi.fn(),
  };
});

import { syncGitHubProjectOnce } from "../../src/services/githubPolling.js";
import { createTaskFromTemplate } from "../../src/services/taskEngine.js";

describe("githubPolling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("imports new GitHub issue and creates default task", async () => {
    const prisma = {
      artifact: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "issue-1" }),
      },
      task: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      project: { update: vi.fn().mockResolvedValue({}) },
      step: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    (createTaskFromTemplate as any).mockResolvedValue({ id: "task-1", steps: [] });

    const parseRepo = vi.fn().mockReturnValue({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });
    const listIssues = vi.fn().mockResolvedValue([
      {
        id: 101,
        number: 7,
        title: "Bug",
        body: "Desc",
        state: "open",
        html_url: "https://github.com/o/r/issues/7",
        labels: [{ name: "bug" }],
        updated_at: "2026-01-27T00:00:00.000Z",
      },
    ]);
    const listPullRequests = vi.fn().mockResolvedValue([]);

    await syncGitHubProjectOnce(
      { prisma, log: vi.fn(), github: { parseRepo, listIssues, listPullRequests } },
      {
        id: "p1",
        scmType: "github",
        repoUrl: "https://github.com/o/r",
        githubAccessToken: "tok",
        githubPollingEnabled: true,
        githubPollingCursor: null,
      },
      { overlapSeconds: 0 },
    );

    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          title: "Bug",
          externalProvider: "github",
          externalId: "101",
          externalNumber: 7,
          externalUrl: "https://github.com/o/r/issues/7",
        }),
      }),
    );

    expect(createTaskFromTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "issue-1",
      expect.objectContaining({ templateKey: "quick.dev.full" }),
    );
    expect(prisma.project.update).toHaveBeenCalled();
  });

  it("imports new GitHub PR and creates PR review task with githubPr params", async () => {
    const prisma = {
      artifact: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "issue-pr-1" }),
      },
      task: {
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      project: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    (createTaskFromTemplate as any).mockResolvedValue({
      id: "task-pr-1",
      steps: [{ id: "step-1", order: 1, params: { mode: "ai" } }],
    });

    const parseRepo = vi.fn().mockReturnValue({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });
    const listIssues = vi.fn().mockResolvedValue([]);
    const listPullRequests = vi.fn().mockResolvedValue([
      {
        id: 201,
        number: 12,
        title: "Feat",
        body: "PR body",
        state: "open",
        html_url: "https://github.com/o/r/pull/12",
        head: { ref: "feature", sha: "abcdef1234567890" },
        base: { ref: "main" },
        updated_at: "2026-01-27T00:00:10.000Z",
      },
    ]);

    await syncGitHubProjectOnce(
      { prisma, log: vi.fn(), github: { parseRepo, listIssues, listPullRequests } },
      {
        id: "p1",
        scmType: "github",
        repoUrl: "https://github.com/o/r",
        githubAccessToken: "tok",
        githubPollingEnabled: true,
        githubPollingCursor: null,
      },
      { overlapSeconds: 0 },
    );

    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "p1",
          title: "[PR #12] Feat",
          externalProvider: "github",
          externalId: "201",
          externalNumber: 12,
          externalUrl: "https://github.com/o/r/pull/12",
        }),
      }),
    );

    expect(createTaskFromTemplate).toHaveBeenCalledWith(
      expect.anything(),
      "issue-pr-1",
      expect.objectContaining({ templateKey: "quick.pr.review" }),
    );

    expect(prisma.task.update.mock.calls.some((c: any[]) => c?.[0]?.data?.baseBranch === "main")).toBe(true);
    expect(prisma.step.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "step-1" },
        data: expect.objectContaining({
          params: expect.objectContaining({
            githubPr: expect.objectContaining({
              provider: "github",
              owner: "o",
              repo: "r",
              number: 12,
              url: "https://github.com/o/r/pull/12",
              baseBranch: "main",
              headBranch: "feature",
              headSha: "abcdef1234567890",
            }),
          }),
        }),
      }),
    );
  });

  it("paginates issues even when a page is all PRs", async () => {
    const prisma = {
      artifact: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue({}) },
      issue: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "issue-2" }),
      },
      task: {
        findFirst: vi.fn().mockResolvedValue({ id: "existing-task" }),
        update: vi.fn().mockResolvedValue({}),
      },
      project: { update: vi.fn().mockResolvedValue({}) },
      step: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const parseRepo = vi.fn().mockReturnValue({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });

    const listIssues = vi.fn().mockImplementation(async (_auth: any, params: any) => {
      const page = Number(params?.page ?? 1);
      if (page === 1) {
        const prs = Array.from({ length: 100 }).map((_, idx) => ({
          id: 1000 + idx,
          number: 100 + idx,
          title: `PR ${idx}`,
          body: null,
          state: "open",
          html_url: `https://github.com/o/r/pull/${100 + idx}`,
          pull_request: { url: "x" },
          labels: [],
          updated_at: "2026-01-27T00:00:00.000Z",
        }));
        return prs;
      }
      if (page === 2) {
        return [
          {
            id: 202,
            number: 9,
            title: "Issue after PR pages",
            body: "Body",
            state: "open",
            html_url: "https://github.com/o/r/issues/9",
            labels: [],
            updated_at: "2026-01-27T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    const listPullRequests = vi.fn().mockResolvedValue([]);

    await syncGitHubProjectOnce(
      { prisma, log: vi.fn(), github: { parseRepo, listIssues, listPullRequests } },
      {
        id: "p1",
        scmType: "github",
        repoUrl: "https://github.com/o/r",
        githubAccessToken: "tok",
        githubPollingEnabled: true,
        githubPollingCursor: "2026-01-26T00:00:00.000Z",
      },
      { overlapSeconds: 0 },
    );

    expect(listIssues).toHaveBeenCalledTimes(2);
    expect(prisma.issue.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ externalId: "202", externalNumber: 9 }),
      }),
    );
  });

  it("does not create a new Issue when PR artifact exists; updates artifact instead", async () => {
    const prisma = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: "a1", content: { provider: "github", number: 12, webUrl: "x" } }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      task: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      step: { update: vi.fn().mockResolvedValue({}) },
      project: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const parseRepo = vi.fn().mockReturnValue({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });
    const listIssues = vi.fn().mockResolvedValue([]);
    const listPullRequests = vi.fn().mockResolvedValue([
      {
        id: 201,
        number: 12,
        title: "Feat",
        body: "PR body",
        state: "open",
        html_url: "https://github.com/o/r/pull/12",
        head: { ref: "feature", sha: "abcdef1234567890" },
        base: { ref: "main" },
        updated_at: "2026-01-27T00:00:10.000Z",
      },
    ]);

    await syncGitHubProjectOnce(
      { prisma, log: vi.fn(), github: { parseRepo, listIssues, listPullRequests } },
      {
        id: "p1",
        scmType: "github",
        repoUrl: "https://github.com/o/r",
        githubAccessToken: "tok",
        githubPollingEnabled: true,
        githubPollingCursor: null,
      },
      { overlapSeconds: 0 },
    );

    expect(prisma.issue.create).not.toHaveBeenCalled();
    expect(prisma.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({
          content: expect.objectContaining({ number: 12, headSha: "abcdef1234567890", targetBranch: "main" }),
        }),
      }),
    );
  });
});

