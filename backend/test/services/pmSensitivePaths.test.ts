import { describe, expect, it } from "vitest";

import { computeSensitiveHitFromFiles, computeSensitiveHitFromPaths } from "../../src/modules/pm/pmSensitivePaths.js";

describe("pmSensitivePaths", () => {
  it("returns null when patterns empty", () => {
    expect(computeSensitiveHitFromPaths(["a.pem"], [])).toBeNull();
    expect(computeSensitiveHitFromPaths(["a.pem"], null as any)).toBeNull();
  });

  it("matches globs and normalizes paths to posix", () => {
    const hit = computeSensitiveHitFromPaths(["a\\b\\c.pem", "x/y/z.txt"], ["  **/*.pem  "]);
    expect(hit).toEqual({ matchedFiles: ["a\\b\\c.pem"], patterns: ["**/*.pem"] });
  });

  it("collects multiple matched patterns without duplicates", () => {
    const hit = computeSensitiveHitFromPaths(["docs/a.pem"], ["**/*.pem", "docs/*", "docs/*"]);
    expect(hit).toEqual({ matchedFiles: ["docs/a.pem"], patterns: ["**/*.pem", "docs/*"] });
  });

  it("computeSensitiveHitFromFiles delegates to computeSensitiveHitFromPaths", () => {
    const hit = computeSensitiveHitFromFiles([{ path: "a.txt" }, { path: "dir/b.pem" }], ["**/*.pem"]);
    expect(hit).toEqual({ matchedFiles: ["dir/b.pem"], patterns: ["**/*.pem"] });
  });
});
