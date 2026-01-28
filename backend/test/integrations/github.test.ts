import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIssueComment,
  createPullRequest,
  createPullRequestReview,
  getIssue,
  getPullRequest,
  listIssues,
  listPullRequestFiles,
  listPullRequests,
  mergePullRequest,
  parseGitHubRepo,
} from "../../src/integrations/github.js";

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as any;
}

function err(status: number, text: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  } as any;
}

describe("integrations/github", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parseGitHubRepo supports https / ssh / enterprise", () => {
    expect(parseGitHubRepo("")).toBeNull();
    expect(parseGitHubRepo("  ")).toBeNull();
    expect(parseGitHubRepo("not a url")).toBeNull();

    expect(parseGitHubRepo("https://github.com/o/r.git")).toEqual({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });

    expect(parseGitHubRepo("git@github.com:o/r.git")).toEqual({
      host: "github.com",
      owner: "o",
      repo: "r",
      webBaseUrl: "https://github.com/o/r",
      apiBaseUrl: "https://api.github.com",
    });

    expect(parseGitHubRepo("https://ghe.example.com/org/repo")).toEqual({
      host: "ghe.example.com",
      owner: "org",
      repo: "repo",
      webBaseUrl: "https://ghe.example.com/org/repo",
      apiBaseUrl: "https://ghe.example.com/api/v3",
    });
  });

  it("listIssues filters pull_request by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson([
        { id: 1, number: 1, title: "I", state: "open", html_url: "u" },
        { id: 2, number: 2, title: "PR", state: "open", html_url: "u2", pull_request: { url: "x" } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = { apiBaseUrl: "https://api.github.com", owner: "o", repo: "r", accessToken: "tok" };
    const res = await listIssues(auth, { state: "open" });
    expect(res.map((x) => x.number)).toEqual([1]);

    const res2 = await listIssues(auth, { state: "open", includePullRequests: true });
    expect(res2.map((x) => x.number).sort()).toEqual([1, 2]);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("getIssue throws when issue is a pull request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ id: 1, number: 3, pull_request: { url: "x" } })));
    const auth = { apiBaseUrl: "https://api.github.com", owner: "o", repo: "r", accessToken: "tok" };
    await expect(getIssue(auth, { issueNumber: 3 })).rejects.toThrow(/is a pull request/i);
  });

  it("listPullRequests clamps per_page and normalizes page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson([]));
    vi.stubGlobal("fetch", fetchMock);

    const auth = { apiBaseUrl: "https://api.github.com", owner: "o", repo: "r", accessToken: "tok" };
    await listPullRequests(auth, { page: 0 as any, perPage: 999, direction: "asc" });

    const [urlRaw] = fetchMock.mock.calls[0];
    const url = new URL(urlRaw);
    expect(url.pathname).toBe("/repos/o/r/pulls");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("direction")).toBe("asc");
  });

  it("creates review / PR / comment and includes optional commit_id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 9, html_url: "c" }))
      .mockResolvedValueOnce(okJson({ id: 10, number: 1, html_url: "pr", head: { ref: "h" }, base: { ref: "b" } }))
      .mockResolvedValueOnce(okJson({ merged: true, message: "ok" }))
      .mockResolvedValueOnce(okJson([{ filename: "a.ts", patch: "+1" }]))
      .mockResolvedValueOnce(okJson({ id: 10, number: 1, html_url: "pr", head: { ref: "h" }, base: { ref: "b" } }))
      .mockResolvedValueOnce(okJson({ id: 11 }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = { apiBaseUrl: "https://api.github.com", owner: "o", repo: "r", accessToken: "tok" };

    await createIssueComment(auth, { issueNumber: 1, body: "hi" });
    await createPullRequest(auth, { head: "h", base: "b", title: "t", body: "x" });
    await mergePullRequest(auth, { pullNumber: 1, mergeMethod: "squash" });
    await listPullRequestFiles(auth, { pullNumber: 1 });
    await getPullRequest(auth, { pullNumber: 1 });
    await createPullRequestReview(auth, { pullNumber: 1, body: "LGTM", event: "APPROVE", commitId: "abc" });

    const reviewCall = fetchMock.mock.calls.at(-1)!;
    expect(reviewCall[1].method).toBe("POST");
    const reviewBody = JSON.parse(String(reviewCall[1].body));
    expect(reviewBody).toMatchObject({ event: "APPROVE", commit_id: "abc" });
  });

  it("throws with status/text when GitHub API returns not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(err(500, "boom")));
    const auth = { apiBaseUrl: "https://api.github.com", owner: "o", repo: "r", accessToken: "tok" };
    await expect(getPullRequest(auth, { pullNumber: 1 })).rejects.toThrow(/GitHub API GET .* failed: 500 boom/i);
  });
});
