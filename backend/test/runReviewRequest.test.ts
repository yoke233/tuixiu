import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReviewRequestForRun, mergeReviewRequestForRun, syncReviewRequestForRun } from "../src/services/runReviewRequest.js";

function makeDeps(overrides: {
  issue?: Record<string, unknown>;
  project?: Record<string, unknown>;
  run?: Record<string, unknown>;
}) {
  const project = {
    scmType: "github",
    repoUrl: "https://github.com/o/r",
    defaultBranch: "main",
    githubAccessToken: "ghp_xxx",
    ...overrides.project,
  };

  const issue = {
    id: "i1",
    title: "Issue title",
    description: "Issue desc",
    externalProvider: "github",
    externalNumber: 3,
    externalUrl: "https://github.com/o/r/issues/3",
    project,
    ...overrides.issue,
  };

  const run = {
    id: "r1",
    branchName: "feat/test",
    workspacePath: "D:\\tmp",
    issue,
    artifacts: [],
    ...overrides.run,
  };

  const prisma = {
    run: {
      findUnique: vi.fn().mockResolvedValue(run),
      update: vi.fn().mockResolvedValue({}),
    },
    artifact: {
      create: vi.fn().mockResolvedValue({ id: "a1" }),
    },
  } as any;

  const gitPush = vi.fn().mockResolvedValue(undefined);
  const parseRepo = vi.fn().mockReturnValue({ apiBaseUrl: "https://api.github.com", owner: "o", repo: "r" });
  const createPullRequest = vi.fn().mockResolvedValue({
    number: 99,
    id: 12345,
    html_url: "https://github.com/o/r/pull/99",
    state: "open",
    title: "PR title",
    head: { ref: "feat/test" },
    base: { ref: "main" },
  });

  return { prisma, gitPush, parseRepo, createPullRequest };
}

describe("createReviewRequestForRun", () => {
  beforeEach(() => {
    // PR 创建成功后会 best-effort 回写 GitHub Issue 评论；测试中禁用真实网络请求。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GitHub issue 来源：创建 PR 时自动追加 Closes #<number>", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({});

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: "Issue desc\n\nCloses #3" }),
    );
  });

  it("body 已包含 issue 引用时，不重复追加", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
      issue: { description: "Hello\n\nCloses #3" },
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: "Hello\n\nCloses #3" }),
    );
  });

  it("避免把 #30 误判成 #3：仍应追加 Closes #3", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
      issue: { description: "Relates #30" },
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: "Relates #30\n\nCloses #3" }),
    );
  });

  it("body 已包含 issue URL 时，不追加 Closes #<number>", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
      issue: { description: "See https://github.com/o/r/issues/3" },
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: "See https://github.com/o/r/issues/3" }),
    );
  });

  it("BoxLite git_clone：跳过 gitPush（由 VM 内 Agent 负责 push）", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
      run: {
        agent: {
          capabilities: {
            sandbox: { provider: "boxlite_oci", boxlite: { workspaceMode: "git_clone" } },
          },
        },
      },
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(gitPush).not.toHaveBeenCalled();
    expect(createPullRequest).toHaveBeenCalled();
  });

  it("UNSUPPORTED_SCM：不应尝试 gitPush", async () => {
    const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
      project: { scmType: "gitee" },
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(false);
    expect((res as any).error?.code).toBe("UNSUPPORTED_SCM");
    expect(gitPush).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("NOT_FOUND when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await createReviewRequestForRun({ prisma, gitPush: vi.fn() } as any, "r1", {});
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NOT_FOUND");
  });

  it("returns existing PR when scmPrUrl exists", async () => {
    const { prisma, gitPush } = makeDeps({
      run: { scmProvider: "github", scmPrNumber: 9, scmPrUrl: "https://github.com/o/r/pull/9", scmPrState: "open" },
    });

    const res = await createReviewRequestForRun({ prisma, gitPush } as any, "r1", {});
    expect(res).toEqual({
      success: true,
      data: { pr: { provider: "github", number: 9, url: "https://github.com/o/r/pull/9", state: "open" } },
    });
  });

  it("taskId fallback: returns latest PR Artifact when present", async () => {
    const { prisma, gitPush } = makeDeps({
      run: { taskId: "t1", scmPrUrl: null, scmPrNumber: null },
    });
    prisma.artifact.findFirst = vi.fn().mockResolvedValue({ id: "a-pr-1", type: "pr", content: { webUrl: "u" } });

    const res = await createReviewRequestForRun({ prisma, gitPush } as any, "r1", {});
    expect(res).toEqual({ success: true, data: { pr: { id: "a-pr-1", type: "pr", content: { webUrl: "u" } } } });
  });

  it("NO_BRANCH when branch is missing", async () => {
    const { prisma, gitPush } = makeDeps({ run: { branchName: null, artifacts: [] } });
    const res = await createReviewRequestForRun({ prisma, gitPush } as any, "r1", {});
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NO_BRANCH");
  });

  it("GIT_PUSH_FAILED when gitPush throws", async () => {
    const { prisma } = makeDeps({});
    const gitPush = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await createReviewRequestForRun({ prisma, gitPush } as any, "r1", {});
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("GIT_PUSH_FAILED");
  });

  it("GitLab: creates merge request and updates run scm state", async () => {
    const project = {
      scmType: "gitlab",
      repoUrl: "https://gitlab.example.com/group/repo.git",
      defaultBranch: "main",
      gitlabProjectId: 123,
      gitlabAccessToken: "tok",
      githubAccessToken: "gh",
    };
    const issue = {
      id: "i1",
      title: "Issue title",
      description: "Issue desc",
      externalProvider: "github",
      externalNumber: 3,
      externalUrl: "https://github.com/o/r/issues/3",
      projectId: "p1",
      project,
    };
    const run = { id: "r1", branchName: "run/r1", workspacePath: "D:\\tmp", issue, artifacts: [] };

    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(run), update: vi.fn().mockResolvedValue({}) },
      artifact: { findFirst: vi.fn() },
    } as any;

    const gitPush = vi.fn().mockResolvedValue(undefined);
    const createMergeRequest = vi.fn().mockResolvedValue({
      id: 1,
      iid: 7,
      title: "t",
      state: "opened",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main",
    });

    const res = await createReviewRequestForRun(
      { prisma, gitPush, gitlab: { inferBaseUrl: () => "https://gitlab.example.com", createMergeRequest } } as any,
      "r1",
      {},
    );

    expect(res.success).toBe(true);
    expect(createMergeRequest).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalled();
  });
});

describe("mergeReviewRequestForRun", () => {
  it("NOT_FOUND when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await mergeReviewRequestForRun({ prisma } as any, "r1", {});
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NOT_FOUND");
  });

  it("NO_PR when pr number missing", async () => {
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", issue: { project: { scmType: "github" } }, artifacts: [] }) },
    } as any;
    const res = await mergeReviewRequestForRun({ prisma } as any, "r1", {});
    expect(res.success).toBe(false);
    expect((res as any).error.code).toBe("NO_PR");
  });

  it("GitLab: merges MR and updates issue/run when merged", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrNumber: 7,
          scmPrUrl: "https://gitlab.example.com/mr/7",
          issue: { id: "i1", project: { scmType: "gitlab", repoUrl: "https://gitlab.example.com/group/repo.git", gitlabProjectId: 123, gitlabAccessToken: "tok" } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const mergeMergeRequest = vi.fn().mockResolvedValue({
      id: 1,
      iid: 7,
      title: "t",
      state: "merged",
      web_url: "https://gitlab.example.com/mr/7",
      source_branch: "run/r1",
      target_branch: "main",
    });
    const getMergeRequest = vi.fn().mockResolvedValue({
      id: 1,
      iid: 7,
      title: "t",
      state: "merged",
      web_url: "https://gitlab.example.com/mr/7",
      source_branch: "run/r1",
      target_branch: "main",
    });

    const res = await mergeReviewRequestForRun(
      { prisma, gitPush: vi.fn(), gitlab: { inferBaseUrl: () => "https://gitlab.example.com", mergeMergeRequest, getMergeRequest } } as any,
      "r1",
      { squash: true },
    );

    expect(res.success).toBe(true);
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "done" } });
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "completed" } });
  });

  it("GitHub: merges PR and updates issue/run when merged", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrNumber: 9,
          scmPrUrl: "https://github.com/o/r/pull/9",
          issue: { id: "i1", project: { scmType: "github", repoUrl: "https://github.com/o/r", githubAccessToken: "tok" } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const parseRepo = vi.fn().mockReturnValue({ apiBaseUrl: "https://api.github.com", owner: "o", repo: "r" });
    const mergePullRequest = vi.fn().mockResolvedValue({ merged: true, message: "ok" });
    const getPullRequest = vi.fn().mockRejectedValue(new Error("ignore"));

    const res = await mergeReviewRequestForRun(
      { prisma, gitPush: vi.fn(), github: { parseRepo, mergePullRequest, getPullRequest } } as any,
      "r1",
      { squash: true, mergeCommitMessage: "m" },
    );

    expect(res.success).toBe(true);
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "done" } });
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "completed" } });
  });
});

describe("syncReviewRequestForRun", () => {
  it("GitHub: fetches PR state and updates issue/run when merged", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrNumber: 9,
          scmPrUrl: "https://github.com/o/r/pull/9",
          scmHeadSha: "h1",
          issue: { id: "i1", project: { scmType: "github", repoUrl: "https://github.com/o/r", githubAccessToken: "tok" } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
    } as any;

    const parseRepo = vi.fn().mockReturnValue({ apiBaseUrl: "https://api.github.com", owner: "o", repo: "r" });
    const getPullRequest = vi.fn().mockResolvedValue({
      id: 1,
      number: 9,
      state: "closed",
      merged_at: "2026-01-01T00:00:00.000Z",
      html_url: "https://github.com/o/r/pull/9",
      head: { ref: "h", sha: "sha" },
      base: { ref: "main" },
    });

    const res = await syncReviewRequestForRun(
      { prisma, gitPush: vi.fn(), github: { parseRepo, getPullRequest } } as any,
      "r1",
    );

    expect(res.success).toBe(true);
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "done" } });
    expect(prisma.run.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { status: "completed" } });
  });
});

