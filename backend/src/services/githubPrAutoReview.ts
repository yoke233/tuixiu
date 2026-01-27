import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import * as github from "../integrations/github.js";
import { uuidv7 } from "../utils/uuid.js";
import { callPmLlmJson, isPmLlmEnabled } from "./pm/pmLlm.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type QueueTask = () => Promise<void>;

function truthyEnv(value: string | undefined): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

export function isGitHubPrAutoReviewEnabled(): boolean {
  return truthyEnv(process.env.GITHUB_PR_AUTO_REVIEW_ENABLED) && isPmLlmEnabled();
}

function enqueueByKey(queue: Map<string, Promise<void>>, key: string, task: QueueTask): Promise<void> {
  const prev = queue.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (queue.get(key) === next) queue.delete(key);
    });
  queue.set(key, next);
  return next;
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n\n…（截断，原始长度=${text.length}）`;
}

function renderReviewComment(opts: {
  prNumber: number;
  prUrl?: string;
  headSha: string;
  verdict: "approve" | "changes_requested";
  markdown: string;
}): string {
  const lines: string[] = [];
  lines.push("### 🤖 自动代码评审（ACP 协作台）");
  lines.push("");
  lines.push(`- PR：#${opts.prNumber}${opts.prUrl ? `（${opts.prUrl}）` : ""}`);
  lines.push(`- Head：\`${opts.headSha.slice(0, 12)}\``);
  lines.push(`- 结论：\`${opts.verdict}\``);
  lines.push("");
  lines.push(String(opts.markdown ?? "").trim());
  lines.push("");
  lines.push("> 说明：评审基于 GitHub PR files patch（可能被截断），仅供参考。");
  return lines.filter(Boolean).join("\n");
}

const reviewSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        message: z.string().min(1),
        path: z.string().optional(),
      }),
    )
    .default([]),
  markdown: z.string().min(1),
});

async function runGitHubPrAutoReviewOnce(
  deps: {
    prisma: PrismaDeps;
    listPullRequestFiles?: typeof github.listPullRequestFiles;
    createIssueComment?: typeof github.createIssueComment;
    callLlmJson?: typeof callPmLlmJson;
  },
  opts: {
    prArtifactId: string;
    prNumber?: number;
    prUrl?: string | null;
    title?: string | null;
    body?: string | null;
    headSha: string;
    sourceBranch?: string | null;
    targetBranch?: string | null;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();

  const prArtifact = await deps.prisma.artifact
    .findUnique({
      where: { id: opts.prArtifactId },
      include: { run: { include: { issue: { include: { project: true } } } } } as any,
    })
    .catch(() => null);
  if (!prArtifact || (prArtifact as any).type !== "pr") return;

  const run: any = (prArtifact as any).run;
  const issue: any = run?.issue;
  const project: any = issue?.project;
  if (!run || !issue || !project) return;

  const token = String(project.githubAccessToken ?? "").trim();
  if (!token) return;

  const content = ((prArtifact as any).content ?? {}) as any;
  const headSha = String(opts.headSha ?? content.headSha ?? "").trim();
  if (!headSha) return;

  const lastHeadSha = String(content.lastAutoReviewHeadSha ?? "").trim();
  if (lastHeadSha && lastHeadSha === headSha) return;

  const prNumber = Number.isFinite(opts.prNumber as any) ? Number(opts.prNumber) : Number(content.number);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return;

  const auth: github.GitHubAuth | null =
    typeof content.apiBaseUrl === "string" &&
    typeof content.owner === "string" &&
    typeof content.repo === "string" &&
    content.apiBaseUrl.trim() &&
    content.owner.trim() &&
    content.repo.trim()
      ? {
          apiBaseUrl: String(content.apiBaseUrl),
          owner: String(content.owner),
          repo: String(content.repo),
          accessToken: token,
        }
      : (() => {
          const parsed = github.parseGitHubRepo(String(project.repoUrl ?? ""));
          if (!parsed) return null;
          return { apiBaseUrl: parsed.apiBaseUrl, owner: parsed.owner, repo: parsed.repo, accessToken: token };
        })();
  if (!auth) return;

  const listPullRequestFiles = deps.listPullRequestFiles ?? github.listPullRequestFiles;
  const createIssueComment = deps.createIssueComment ?? github.createIssueComment;
  const callLlm = deps.callLlmJson ?? callPmLlmJson;

  const maxFilesRaw = Number(process.env.GITHUB_PR_AUTO_REVIEW_MAX_FILES ?? 30);
  const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? Math.min(maxFilesRaw, 80) : 30;
  const maxPatchCharsRaw = Number(process.env.GITHUB_PR_AUTO_REVIEW_MAX_PATCH_CHARS ?? 8000);
  const maxPatchChars = Number.isFinite(maxPatchCharsRaw) && maxPatchCharsRaw > 0 ? Math.min(maxPatchCharsRaw, 20000) : 8000;

  let files: github.GitHubPullRequestFile[] = [];
  try {
    files = await listPullRequestFiles(auth, { pullNumber: prNumber, perPage: 100, page: 1 });
  } catch (err) {
    await deps.prisma.event
      .create({
        data: {
          id: uuidv7(),
          runId: run.id,
          source: "system",
          type: "github.pr.auto_review.fetch_files_failed",
          payload: { prNumber, headSha, error: String(err) } as any,
        } as any,
      })
      .catch(() => {});
    return;
  }

  const prTitle = String(opts.title ?? content.title ?? "").trim();
  const prBody = String(opts.body ?? content.body ?? "").trim();
  const prUrl = String(opts.prUrl ?? content.webUrl ?? "").trim();
  const sourceBranch = String(opts.sourceBranch ?? content.sourceBranch ?? "").trim();
  const targetBranch = String(opts.targetBranch ?? content.targetBranch ?? "").trim();

  const patchBlocks: string[] = [];
  const clipped = files.slice(0, maxFiles);
  for (const f of clipped) {
    const filename = String((f as any).filename ?? "").trim();
    if (!filename) continue;
    const status = String((f as any).status ?? "").trim();
    const patch = typeof (f as any).patch === "string" ? (f as any).patch : "";
    patchBlocks.push(
      [
        `FILE: ${filename}`,
        status ? `STATUS: ${status}` : "",
        patch ? clampText(patch, maxPatchChars) : "（无 patch：可能是二进制/过大/被截断）",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const system: ChatMessage = {
    role: "system",
    content: [
      "你是严谨的代码审查员。请根据给定的 Pull Request 变更给出评审结论。",
      "",
      "只输出一个 JSON 对象（不要输出多余文字/不要用 Markdown 代码块包裹）。字段：",
      '- verdict: "approve" | "changes_requested"',
      '- findings: { severity: "high"|"medium"|"low"; message: string; path?: string }[]',
      "- markdown: string（用于贴到 PR 评论区的 Markdown；建议包含：总体评价、关键问题、可执行建议）",
      "",
      "要求：",
      "- 优先指出会导致 bug/安全/数据一致性/可维护性问题的点；无问题也要给出简短通过说明。",
      "- 如果 patch 被截断，请在 markdown 里明确提示并给出风险。",
      "- 不要臆测仓库上下文中不存在的信息。",
    ].join("\n"),
  };

  const user: ChatMessage = {
    role: "user",
    content: [
      `PR #${prNumber}`,
      prUrl ? `URL: ${prUrl}` : "",
      prTitle ? `TITLE: ${prTitle}` : "",
      sourceBranch && targetBranch ? `BRANCH: ${sourceBranch} -> ${targetBranch}` : "",
      `HEAD_SHA: ${headSha}`,
      prBody ? `DESCRIPTION:\n${clampText(prBody, 4000)}` : "",
      "",
      `FILES（最多 ${maxFiles} 个；patch 可能截断）：`,
      "",
      patchBlocks.join("\n\n---\n\n"),
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const llm = await callLlm({
    schema: reviewSchema,
    messages: [system, user] as any,
    temperature: 0.2,
    maxTokens: 900,
  });

  if (!llm.ok) {
    await deps.prisma.event
      .create({
        data: {
          id: uuidv7(),
          runId: run.id,
          source: "system",
          type: "github.pr.auto_review.llm_failed",
          payload: { prNumber, headSha, error: llm.error } as any,
        } as any,
      })
      .catch(() => {});
    return;
  }

  const review = llm.value;
  const reportArtifact = await deps.prisma.artifact
    .create({
      data: {
        id: uuidv7(),
        runId: run.id,
        type: "report",
        content: {
          kind: "github_pr_auto_review",
          version: 1,
          provider: "github",
          prNumber,
          prUrl,
          headSha,
          verdict: review.verdict,
          findings: review.findings,
          markdown: review.markdown,
          model: llm.model,
          createdAt: nowIso,
        } as any,
      } as any,
      select: { id: true } as any,
    })
    .catch(() => null);

  const commentBody = renderReviewComment({
    prNumber,
    prUrl: prUrl || undefined,
    headSha,
    verdict: review.verdict,
    markdown: review.markdown,
  });

  let commentId: number | null = null;
  let commentError: string | null = null;
  try {
    const comment = await createIssueComment(auth, { issueNumber: prNumber, body: clampText(commentBody, 60_000) });
    commentId = typeof (comment as any)?.id === "number" ? (comment as any).id : null;
  } catch (err) {
    commentError = String(err);
  }

  await deps.prisma.artifact
    .update({
      where: { id: (prArtifact as any).id },
      data: {
        content: {
          ...content,
          lastAutoReviewHeadSha: headSha,
          lastAutoReviewAt: nowIso,
          lastAutoReviewArtifactId: (reportArtifact as any)?.id ?? null,
          lastAutoReviewCommentId: commentId,
          lastAutoReviewCommentError: commentError,
          lastAutoReviewVerdict: review.verdict,
          lastWebhookAt: content.lastWebhookAt ?? nowIso,
        } as any,
      } as any,
    })
    .catch(() => {});

  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: run.id,
        source: "system",
        type: commentError ? "github.pr.auto_review.commented_failed" : "github.pr.auto_review.commented",
        payload: { prNumber, headSha, verdict: review.verdict, commentId, error: commentError } as any,
      } as any,
    })
    .catch(() => {});
}

const prQueue = new Map<string, Promise<void>>();

export function triggerGitHubPrAutoReview(
  deps: {
    prisma: PrismaDeps;
    listPullRequestFiles?: typeof github.listPullRequestFiles;
    createIssueComment?: typeof github.createIssueComment;
    callLlmJson?: typeof callPmLlmJson;
  },
  opts: {
    prArtifactId: string;
    prNumber?: number;
    prUrl?: string | null;
    title?: string | null;
    body?: string | null;
    headSha: string;
    sourceBranch?: string | null;
    targetBranch?: string | null;
  },
) {
  if (!isGitHubPrAutoReviewEnabled()) return;
  if (!opts.prArtifactId) return;
  if (!opts.headSha) return;

  const key = opts.prArtifactId;
  return enqueueByKey(prQueue, key, async () => {
    await runGitHubPrAutoReviewOnce(deps, opts).catch(() => {});
  });
}
