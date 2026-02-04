import { describe, expect, it } from "vitest";
import path from "node:path";

import { parseGitDirFromWorktree, resolveBaseRepoFromGitDir } from "./gitWorktree.js";

describe("gitWorktree", () => {
  it("parses gitdir from .git file content", () => {
    const content = "gitdir: C:/repo/.git/worktrees/run-1";
    const gitDir = parseGitDirFromWorktree(content);
    expect(gitDir).toBe(path.normalize("C:/repo/.git/worktrees/run-1"));
  });

  it("resolves base repo from gitdir", () => {
    const gitDir = path.normalize("C:/repo/.git/worktrees/run-1");
    expect(resolveBaseRepoFromGitDir(gitDir)).toBe(path.normalize("C:/repo"));
  });
});
