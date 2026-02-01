import { describe, expect, it } from "vitest";

import {
  parseSkillFrontMatter,
  sanitizeSkillText,
  sanitizeTags,
} from "../../../src/modules/skills/skillFrontMatter.js";

describe("skillFrontMatter", () => {
  it("returns null when no front matter", () => {
    const input = "# Title\n\nBody";
    const out = parseSkillFrontMatter(input);
    expect(out.frontMatter).toBeNull();
    expect(out.body).toBe(input);
    expect(out.rawFrontMatter).toBeNull();
  });

  it("parses yaml-like front matter with blocks and lists", () => {
    const input = `---
name: "My Skill"
description: |
  line1
  line2
tags:
  - Foo
  - bar
inline: [a, "B", c ]
---
Body line`;
    const out = parseSkillFrontMatter(input);
    expect(out.frontMatter).toEqual(
      expect.objectContaining({
        name: "My Skill",
        description: "line1\nline2",
        tags: ["Foo", "bar"],
        inline: ["a", "B", "c"],
      }),
    );
    expect(out.body).toBe("Body line");
    expect(out.rawFrontMatter).toContain("name:");
  });

  it("sanitizes text values", () => {
    expect(sanitizeSkillText(null, 10)).toBeNull();
    expect(sanitizeSkillText("  \0hi\0 ", 10)).toBe("hi");
    expect(sanitizeSkillText("abcd", 2)).toBe("ab");
  });

  it("sanitizes tag arrays", () => {
    const tags = sanitizeTags(["A", "a", " B ", "", 123]);
    expect(tags).toEqual(["a", "b"]);
  });
});
