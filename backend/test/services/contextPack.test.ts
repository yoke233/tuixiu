import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildContextPackPrompt } from "../../src/modules/acp/contextPack.js";

async function makeTempWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-context-"));
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }),
  );
  return dir;
}

describe("Context Pack", () => {
  it("falls back to default mapping when manifest missing", async () => {
    const ws = await makeTempWorkspace({
      "docs/05_process/project-context.md": "PROJECT_CONTEXT",
      "docs/05_process/definition-of-done.md": "DOD",
    });

    const implement = await buildContextPackPrompt({ workspacePath: ws, stepKind: "dev.implement" });
    expect(implement).toContain("PROJECT_CONTEXT");
    expect(implement).not.toContain("DOD");

    const review = await buildContextPackPrompt({ workspacePath: ws, stepKind: "code.review" });
    expect(review).toContain("PROJECT_CONTEXT");
    expect(review).toContain("DOD");
  });

  it("loads docs from context-manifest.json when present", async () => {
    const ws = await makeTempWorkspace({
      "docs/05_process/project-context.md": "PROJECT_CONTEXT",
      "docs/05_process/definition-of-done.md": "DOD",
      "docs/foo.md": "FOO",
      "docs/context-manifest.json": JSON.stringify(
        {
          version: 1,
          docs: {
            foo: { path: "docs/foo.md", title: "Foo", maxChars: 9000 },
          },
          defaults: ["foo"],
          stepKinds: {
            "code.review": [],
          },
        },
        null,
        2,
      ),
    });

    const review = await buildContextPackPrompt({ workspacePath: ws, stepKind: "code.review" });
    expect(review).toContain("FOO");
    expect(review).not.toContain("PROJECT_CONTEXT");
    expect(review).not.toContain("DOD");
  });
});
