import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReviewRequestForRun } from "../src/services/runReviewRequest.js";

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
});

