import { afterEach, describe, expect, it, vi } from "vitest";

import { createMergeRequest, getMergeRequest, inferGitlabBaseUrl, mergeMergeRequest } from "../../src/integrations/gitlab.js";

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

describe("integrations/gitlab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inferGitlabBaseUrl supports https / ssh", () => {
    expect(inferGitlabBaseUrl("")).toBeNull();
    expect(inferGitlabBaseUrl("not a url")).toBeNull();
    expect(inferGitlabBaseUrl("https://gitlab.example.com/group/repo.git")).toBe("https://gitlab.example.com");
    expect(inferGitlabBaseUrl("git@gitlab.example.com:group/repo.git")).toBe("https://gitlab.example.com");
  });

  it("calls GitLab API endpoints and passes token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 1, iid: 2, title: "t", state: "opened", web_url: "u", source_branch: "a", target_branch: "b" }))
      .mockResolvedValueOnce(okJson({ id: 1, iid: 2, title: "t", state: "merged", web_url: "u", source_branch: "a", target_branch: "b" }))
      .mockResolvedValueOnce(okJson({ id: 1, iid: 2, title: "t", state: "merged", web_url: "u", source_branch: "a", target_branch: "b" }));
    vi.stubGlobal("fetch", fetchMock);

    const auth = { baseUrl: "https://gitlab.example.com", projectId: 123, accessToken: "tok" };
    await createMergeRequest(auth, { sourceBranch: "a", targetBranch: "b", title: "t", description: "d" });
    await mergeMergeRequest(auth, { iid: 2, squash: true });
    await getMergeRequest(auth, { iid: 2 });

    const first = fetchMock.mock.calls[0];
    expect(first[1].headers["private-token"]).toBe("tok");
    expect(String(first[0])).toContain("/api/v4/projects/123/merge_requests");
  });

  it("throws with status/text when GitLab API returns not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(err(403, "nope")));
    const auth = { baseUrl: "https://gitlab.example.com", projectId: 123, accessToken: "tok" };
    await expect(getMergeRequest(auth, { iid: 1 })).rejects.toThrow(/GitLab API GET .* failed: 403 nope/i);
  });
});

