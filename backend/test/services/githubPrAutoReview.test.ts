import { describe, expect, it, vi } from "vitest";

import { triggerGitHubPrAutoReview } from "../../src/services/githubPrAutoReview.js";

describe("githubPrAutoReview", () => {
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
});
