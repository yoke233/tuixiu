import { describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import path from "node:path";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();

  (execFile as any)[promisify.custom] = (file: string, args: string[], options?: any) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err: any, stdout: any, stderr: any) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return { execFile };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/redaction.js", () => ({
  redactText: vi.fn((t: string) => t),
  scanForSecrets: vi.fn(() => ({ ok: true, matches: [] })),
}));

const { planArtifactPublish, publishArtifact } = await import("../../src/services/artifactPublish.js");
const { execFile } = await import("node:child_process");
const { mkdir, writeFile } = await import("node:fs/promises");
const { scanForSecrets } = await import("../../src/services/redaction.js");

describe("artifactPublish", () => {
  it("planArtifactPublish returns NOT_FOUND when artifact missing", async () => {
    const prisma = { artifact: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const res = await planArtifactPublish({ prisma }, "a1", {});
    expect(res).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Artifact 不存在" } });
  });

  it("planArtifactPublish returns NO_WORKSPACE when run.workspacePath missing", async () => {
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "report",
          content: { kind: "report", markdown: "hi" },
          run: { id: "r1", workspacePath: null, issue: { id: "i1" } },
        }),
      },
    } as any;
    const res = await planArtifactPublish({ prisma }, "a1", {});
    expect(res).toEqual({
      success: false,
      error: { code: "NO_WORKSPACE", message: "该 Artifact 对应的 Run 没有 workspacePath" },
    });
  });

  it("planArtifactPublish rejects unsafe path", async () => {
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "report",
          content: { kind: "report", markdown: "hi" },
          run: { id: "r1", workspacePath: path.resolve("tmp-ws"), issue: { id: "i1" } },
        }),
      },
    } as any;

    const res = await planArtifactPublish({ prisma }, "a1", { path: "../evil.md" });
    expect(res).toEqual({ success: false, error: { code: "BAD_PATH", message: "path 必须是安全的相对路径" } });
  });

  it("planArtifactPublish returns SECRET_DETECTED when scanForSecrets fails", async () => {
    (scanForSecrets as any).mockReturnValueOnce({ ok: false, matches: [{ name: "X", sample: "x" }] });

    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "report",
          content: { kind: "report", markdown: "hi" },
          run: { id: "r1", workspacePath: path.resolve("tmp-ws"), issue: { id: "i1" } },
        }),
      },
    } as any;

    const res = await planArtifactPublish({ prisma }, "a1", {});
    expect(res).toEqual({
      success: false,
      error: { code: "SECRET_DETECTED", message: "内容疑似包含敏感信息，已阻止发布", details: "X" },
    });
  });

  it("planArtifactPublish uses default path based on issue key and kind", async () => {
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "report",
          content: { kind: "analysis", markdown: "# hi" },
          run: {
            id: "r1",
            workspacePath: path.resolve("tmp-ws"),
            issue: { id: "i1", externalProvider: "GitHub", externalNumber: 123 },
          },
        }),
      },
    } as any;

    const res = await planArtifactPublish({ prisma }, "a1", {});
    expect(res).toEqual({
      success: true,
      data: { kind: "analysis", path: "docs/tuixiu/github-123/analysis.md" },
    });
  });

  it("publishArtifact writes file, runs git, and returns commitSha (even on noop commit)", async () => {
    (execFile as any).mockImplementation((file: string, args: string[], options: any, cb: any) => {
      const sub = String(args?.[0] ?? "");
      if (file === "git" && sub === "commit") {
        const err: any = new Error("noop");
        cb(err, "", "nothing to commit");
        return;
      }
      if (file === "git" && sub === "rev-parse") {
        cb(null, "sha123\n", "");
        return;
      }
      cb(null, "", "");
    });

    const workspacePath = path.resolve("tmp-ws");
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          type: "report",
          content: { kind: "analysis", markdown: "hello" },
          run: { id: "r1", workspacePath, issue: { id: "i1", externalProvider: "github", externalNumber: 123 } },
        }),
        create: vi.fn().mockRejectedValue(new Error("ignore")),
      },
    } as any;

    const res = await publishArtifact({ prisma }, "a1", { path: "docs/out.md" });

    expect(res).toEqual({ success: true, data: { path: "docs/out.md", commitSha: "sha123" } });

    expect(mkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(path.resolve(workspacePath, "docs/out.md"), "hello\n", "utf8");

    expect(execFile).toHaveBeenCalledWith("git", ["add", "docs/out.md"], { cwd: workspacePath }, expect.any(Function));
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["commit", "-m", "docs: publish analysis for github-123"],
      { cwd: workspacePath },
      expect.any(Function),
    );
    expect(execFile).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], { cwd: workspacePath }, expect.any(Function));

    expect(prisma.artifact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        runId: "r1",
        type: "patch",
        content: { path: "docs/out.md", commitSha: "sha123", sourceArtifactId: "a1" },
      }),
    });
  });
});

