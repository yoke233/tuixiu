import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { triggerGitHubPrAutoReview } from "../../src/modules/scm/githubPrAutoReview.js";

describe("githubPrAutoReview", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("creates events + comments and updates run metadata (dedup by head sha)", async () => {
    const prevEnabled = process.env.GITHUB_PR_AUTO_REVIEW_ENABLED;
    const prevKey = process.env.PM_LLM_API_KEY;
    process.env.GITHUB_PR_AUTO_REVIEW_ENABLED = "1";
    process.env.PM_LLM_API_KEY = "test";

    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "pr",
          content: {
            provider: "github",
            apiBaseUrl: "https://api.github.com",
            owner: "o",
            repo: "r",
            number: 123,
            webUrl: "https://github.com/o/r/pull/123",
          },
          run: {
            id: "r1",
            metadata: {},
            issue: { project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" } },
          },
        }),
      },
      run: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const listPullRequestFiles = vi.fn().mockResolvedValue([{ filename: "a.ts", status: "modified", patch: "+1" }]);
    const createPullRequestReview = vi.fn().mockResolvedValue({ id: 999 });
    const callLlmJson = vi.fn().mockResolvedValue({
      ok: true,
      value: { verdict: "approve", findings: [], markdown: "LGTM" },
      rawText: "{\"verdict\":\"approve\"}",
      model: "test-model",
    });

    await triggerGitHubPrAutoReview(
      { prisma, listPullRequestFiles, createPullRequestReview, callLlmJson },
      { prArtifactId: "a1", prNumber: 123, headSha: "abcdef" },
    );

    expect(listPullRequestFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", accessToken: "tok" }),
      expect.objectContaining({ pullNumber: 123 }),
    );
    expect(callLlmJson).toHaveBeenCalled();
    expect(createPullRequestReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pullNumber: 123, event: "APPROVE" }));
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "r1" },
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            githubPrAutoReview: expect.objectContaining({ lastHeadSha: "abcdef", lastVerdict: "approve" }),
          }),
        }),
      }),
    );

    // same head sha -> no-op
    prisma.artifact.findUnique.mockResolvedValueOnce({
      id: "a1",
      type: "pr",
      content: {
        provider: "github",
        apiBaseUrl: "https://api.github.com",
        owner: "o",
        repo: "r",
        number: 123,
      },
      run: {
        id: "r1",
        metadata: { githubPrAutoReview: { lastHeadSha: "abcdef" } },
        issue: { project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" } },
      },
    });

    listPullRequestFiles.mockClear();
    await triggerGitHubPrAutoReview(
      { prisma, listPullRequestFiles, createPullRequestReview, callLlmJson },
      { prArtifactId: "a1", prNumber: 123, headSha: "abcdef" },
    );
    expect(listPullRequestFiles).not.toHaveBeenCalled();

    if (prevEnabled === undefined) delete process.env.GITHUB_PR_AUTO_REVIEW_ENABLED;
    else process.env.GITHUB_PR_AUTO_REVIEW_ENABLED = prevEnabled;
    if (prevKey === undefined) delete process.env.PM_LLM_API_KEY;
    else process.env.PM_LLM_API_KEY = prevKey;
  });

  it("does nothing when auto review disabled", async () => {
    process.env = { ...envBackup, GITHUB_PR_AUTO_REVIEW_ENABLED: "0" };

    const prisma = {
      artifact: { findUnique: vi.fn() },
      event: { create: vi.fn() },
      run: { update: vi.fn() },
    } as any;

    await triggerGitHubPrAutoReview({ prisma } as any, { prArtifactId: "a1", prNumber: 1, headSha: "h1" });
    expect(prisma.artifact.findUnique).not.toHaveBeenCalled();
  });

  it("LLM: records fetch_files_failed when listPullRequestFiles throws", async () => {
    process.env = { ...envBackup, GITHUB_PR_AUTO_REVIEW_ENABLED: "1", PM_LLM_API_KEY: "k" };

    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "pr",
          content: { number: 12, webUrl: "https://github.com/o/r/pull/12" },
          run: { id: "r1", metadata: {}, issue: { projectId: "p1", project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" } } },
        }),
      },
      run: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const listPullRequestFiles = vi.fn().mockRejectedValue(new Error("boom"));

    await triggerGitHubPrAutoReview(
      { prisma, listPullRequestFiles, createPullRequestReview: vi.fn(), callLlmJson: vi.fn() } as any,
      { prArtifactId: "a1", prNumber: 12, headSha: "h1" },
    );

    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.pr.auto_review.fetch_files_failed" }) }),
    );
  });

  it("LLM: records llm_failed when callLlmJson not ok", async () => {
    process.env = { ...envBackup, GITHUB_PR_AUTO_REVIEW_ENABLED: "1", PM_LLM_API_KEY: "k" };

    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "pr",
          content: { number: 12, webUrl: "https://github.com/o/r/pull/12" },
          run: { id: "r1", metadata: {}, issue: { projectId: "p1", project: { githubAccessToken: "tok", repoUrl: "https://github.com/o/r" } } },
        }),
      },
      run: { update: vi.fn().mockResolvedValue({}) },
      event: { create: vi.fn().mockResolvedValue({}) },
    } as any;

    const listPullRequestFiles = vi.fn().mockResolvedValue([{ filename: "a.ts", status: "modified", patch: "+1" }]);
    const callLlmJson = vi.fn().mockResolvedValue({ ok: false, error: "X" });

    await triggerGitHubPrAutoReview(
      { prisma, listPullRequestFiles, createPullRequestReview: vi.fn(), callLlmJson } as any,
      { prArtifactId: "a1", prNumber: 12, headSha: "h1" },
    );

    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "github.pr.auto_review.llm_failed" }) }),
    );
  });

  it("ACP: creates agent run, parses REPORT_JSON and posts PR review", async () => {
    process.env = { ...envBackup, GITHUB_PR_AUTO_REVIEW_ENABLED: "1", GITHUB_PR_AUTO_REVIEW_MODE: "acp" };

    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "pr",
          content: {
            apiBaseUrl: "https://api.github.com",
            owner: "o",
            repo: "r",
            number: 12,
            webUrl: "https://github.com/o/r/pull/12",
          },
          run: {
            id: "r1",
            taskId: null,
            branchName: "run/r1",
            workspacePath: "C:/ws",
            metadata: {},
            issue: { id: "i1", projectId: "p1", title: "t", description: "d", project: { name: "P", repoUrl: "https://github.com/o/r", defaultBranch: "main", githubAccessToken: "tok" } },
          },
        }),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([{ id: "agent-1", status: "online", currentLoad: 0, maxConcurrentRuns: 1, proxyId: "proxy-1", capabilities: {} }]),
        update: vi.fn().mockResolvedValue({}),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ key: "reviewer", displayName: "Reviewer", promptTemplate: "hi {{issue.title}}" }) },
      run: { create: vi.fn().mockResolvedValue({ id: "ar1" }), update: vi.fn().mockResolvedValue({}) },
      event: {
        findMany: vi.fn().mockResolvedValue([
          {
            timestamp: "2026-01-01T00:00:00.000Z",
            source: "acp",
            payload: {
              type: "session_update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "```REPORT_JSON\n{\"verdict\":\"approve\",\"markdown\":\"LGTM\",\"findings\":[]}\n```",
                },
              },
            },
          },
        ]),
        create: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const createPullRequestReview = vi.fn().mockResolvedValue({ id: 1 });
    const acp = { promptRun: vi.fn().mockResolvedValue(undefined) } as any;

    await triggerGitHubPrAutoReview(
      { prisma, acp, createPullRequestReview } as any,
      { prArtifactId: "a1", prNumber: 12, headSha: "h1", baseSha: "b1", prUrl: "https://github.com/o/r/pull/12" },
    );

    expect(prisma.run.create).toHaveBeenCalled();
    expect(acp.promptRun).toHaveBeenCalled();
    expect(createPullRequestReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pullNumber: 12, event: "APPROVE" }));
  });
});
