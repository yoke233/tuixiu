import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/tuixiu-git-askpass-1"),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

const { createGitProcessEnv } = await import("../../src/utils/gitAuth.js");
const { mkdtemp, rm, writeFile } = await import("node:fs/promises");

describe("gitAuth", () => {
  it("returns ssh env when gitAuthMode=ssh", async () => {
    const res = await createGitProcessEnv({
      repoUrl: "git@github.com:org/repo.git",
      scmType: "github",
      gitAuthMode: "ssh",
    });

    expect(res.gitAuthMode).toBe("ssh");
    expect(res.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(res.env.GIT_ASKPASS).toBeUndefined();
    await res.cleanup();

    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it("throws when https_pat but missing token", async () => {
    await expect(
      createGitProcessEnv({
        repoUrl: "https://github.com/org/repo.git",
        scmType: "github",
        gitAuthMode: "https_pat",
        githubAccessToken: "",
      }),
    ).rejects.toThrow("gitAuthMode=https_pat 但未配置 accessToken");
  });

  it("creates askpass script env when https_pat with token", async () => {
    const res = await createGitProcessEnv({
      repoUrl: "https://github.com/org/repo.git",
      scmType: "github",
      gitAuthMode: "https_pat",
      githubAccessToken: "tok",
    });

    expect(res.gitAuthMode).toBe("https_pat");
    expect(res.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(res.env.GCM_INTERACTIVE).toBe("Never");
    expect(res.env.GIT_ASKPASS).toEqual(expect.any(String));
    expect(String(res.env.GIT_ASKPASS)).toMatch(/askpass\.(cmd|sh)$/);

    expect(mkdtemp).toHaveBeenCalledWith(expect.stringContaining("tuixiu-git-askpass-"));
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/askpass\.(cmd|sh)$/),
      expect.stringContaining("tok"),
      expect.objectContaining({ encoding: "utf8" }),
    );

    await res.cleanup();
    expect(rm).toHaveBeenCalledWith("/tmp/tuixiu-git-askpass-1", { recursive: true, force: true });
  });
});

