import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { redactText, scanForSecrets } from "./redaction.js";

const execFileAsync = promisify(execFile);

function isSafeRelativePath(p: string): boolean {
  const raw = String(p ?? "").replaceAll("\\", "/").trim();
  if (!raw) return false;
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return false;
  if (raw.includes("..")) return false;
  return true;
}

function defaultIssueKey(issue: any): string {
  const provider = typeof issue?.externalProvider === "string" ? issue.externalProvider.trim().toLowerCase() : "";
  const num = typeof issue?.externalNumber === "number" ? issue.externalNumber : null;
  if (provider && num && num > 0) return `${provider}-${num}`;
  return typeof issue?.id === "string" ? issue.id : "issue";
}

function defaultPublishPath(opts: { issue: any; kind: string }): string {
  const issueKey = defaultIssueKey(opts.issue);
  const kind = opts.kind || "report";
  return path.join("docs", "tuixiu", issueKey, `${kind}.md`).replaceAll("\\", "/");
}

function toMarkdownFromArtifact(artifact: any): { kind: string; markdown: string } {
  const type = String(artifact?.type ?? "");
  const content = (artifact?.content ?? {}) as any;

  if (type === "report") {
    const kind = typeof content.kind === "string" && content.kind.trim() ? content.kind.trim() : "report";
    const markdown = typeof content.markdown === "string" ? content.markdown : JSON.stringify(content, null, 2);
    return { kind, markdown };
  }

  if (type === "ci_result") {
    const kind = "test";
    const markdown = [
      "# 测试结果",
      "",
      "```json",
      JSON.stringify(content, null, 2),
      "```",
      "",
    ].join("\n");
    return { kind, markdown };
  }

  const kind = "artifact";
  return { kind, markdown: `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\`\n` };
}

async function gitCommitIfNeeded(opts: { cwd: string; message: string }): Promise<string> {
  try {
    await execFileAsync("git", ["commit", "-m", opts.message], { cwd: opts.cwd });
  } catch (err) {
    const msg = String((err as any)?.stderr ?? err);
    const okNoop =
      msg.includes("nothing to commit") ||
      msg.includes("no changes added to commit") ||
      msg.includes("nothing added to commit");
    if (!okNoop) throw err;
  }

  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: opts.cwd });
  return String(stdout ?? "").trim();
}

export async function publishArtifact(deps: { prisma: PrismaDeps }, artifactId: string, body?: { path?: string }) {
  const artifact = await deps.prisma.artifact.findUnique({
    where: { id: artifactId },
    include: {
      run: {
        include: {
          issue: true,
          task: true,
        },
      },
    },
  });
  if (!artifact) {
    return { success: false, error: { code: "NOT_FOUND", message: "Artifact 不存在" } };
  }

  const run = (artifact as any).run;
  const issue = run?.issue;
  const workspacePath = typeof run?.workspacePath === "string" ? run.workspacePath.trim() : "";
  if (!workspacePath) {
    return { success: false, error: { code: "NO_WORKSPACE", message: "该 Artifact 对应的 Run 没有 workspacePath" } };
  }

  const { kind, markdown } = toMarkdownFromArtifact(artifact);

  const rawPath = typeof body?.path === "string" ? body.path.trim() : "";
  const relPath = rawPath ? rawPath : defaultPublishPath({ issue, kind });
  if (!isSafeRelativePath(relPath)) {
    return { success: false, error: { code: "BAD_PATH", message: "path 必须是安全的相对路径" } };
  }

  const safeMarkdown = redactText(markdown);
  const scan = scanForSecrets(safeMarkdown);
  if (!scan.ok) {
    return {
      success: false,
      error: {
        code: "SECRET_DETECTED",
        message: "内容疑似包含敏感信息，已阻止发布",
        details: scan.matches.map((m) => m.name).join(", "),
      },
    };
  }

  const absPath = path.resolve(workspacePath, relPath);
  const root = path.resolve(workspacePath);
  const rootNorm = process.platform === "win32" ? root.toLowerCase() : root;
  const absNorm = process.platform === "win32" ? absPath.toLowerCase() : absPath;
  if (!absNorm.startsWith(rootNorm)) {
    return { success: false, error: { code: "BAD_PATH", message: "path 越界" } };
  }

  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, safeMarkdown.endsWith("\n") ? safeMarkdown : `${safeMarkdown}\n`, "utf8");

  await execFileAsync("git", ["add", relPath], { cwd: workspacePath });
  const commitSha = await gitCommitIfNeeded({
    cwd: workspacePath,
    message: `docs: publish ${kind} for ${defaultIssueKey(issue)}`,
  });

  await deps.prisma.artifact
    .create({
      data: {
        id: uuidv7(),
        runId: run.id,
        type: "patch",
        content: { path: relPath, commitSha, sourceArtifactId: artifact.id } as any,
      },
    })
    .catch(() => {});

  return { success: true, data: { path: relPath, commitSha } };
}

