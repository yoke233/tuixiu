import { describe, expect, it } from "vitest";

import { parseSkillsShSourceKey, parseSkillsShUrl } from "../../../src/modules/skills/skillsSh.js";

describe("skillsSh", () => {
  it("parses source key", () => {
    const ref = parseSkillsShSourceKey("owner/repo@skill");
    expect(ref).toEqual(
      expect.objectContaining({
        sourceType: "skills.sh",
        owner: "owner",
        repo: "repo",
        skill: "skill",
        sourceKey: "owner/repo@skill",
        githubRepoUrl: "https://github.com/owner/repo",
        skillDir: "skills/skill",
      }),
    );
  });

  it("rejects invalid source key segments", () => {
    expect(parseSkillsShSourceKey("owner/repo@../bad")).toBeNull();
    expect(parseSkillsShSourceKey("owner/repo@bad/seg")).toBeNull();
    expect(parseSkillsShSourceKey("owner/repo")).toBeNull();
  });

  it("parses skills.sh url", () => {
    const ref = parseSkillsShUrl("https://skills.sh/owner/repo/skill?x=1");
    expect(ref?.sourceKey).toBe("owner/repo@skill");
    expect(ref?.githubRepoUrl).toBe("https://github.com/owner/repo");
  });

  it("rejects invalid url", () => {
    expect(parseSkillsShUrl("https://example.com/owner/repo/skill")).toBeNull();
  });
});
