import * as github from "../../integrations/github.js";
import type { PrismaDeps } from "../../deps.js";
import { renderTextTemplateFromDb } from "../templates/textTemplates.js";

type CommentKind = "assigned" | "started";
type ApprovalCommentKind =
  | "merge_pr_requested"
  | "merge_pr_approved"
  | "merge_pr_rejected"
  | "merge_pr_executed"
  | "merge_pr_failed"
  | "create_pr_requested"
  | "create_pr_approved"
  | "create_pr_rejected"
  | "create_pr_executed"
  | "create_pr_failed"
  | "publish_artifact_requested"
  | "publish_artifact_approved"
  | "publish_artifact_rejected"
  | "publish_artifact_executed"
  | "publish_artifact_failed";
type PrCommentProvider = "github" | "gitlab" | "unknown";
type AutoReviewNextAction = "create_pr" | "request_create_pr_approval" | "wait_ci" | "request_merge_approval" | "manual_review" | "none";

function fmt(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function renderGitHubIssueCommentFallback(opts: {
  kind: CommentKind;
  agentName: string;
  roleKey?: string | null;
  runId: string;
  branchName?: string | null;
}): string {
  const agentName = String(opts.agentName ?? "").trim() || "unknown";
  const roleKey = typeof opts.roleKey === "string" ? opts.roleKey.trim() : "";
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const branchName = typeof opts.branchName === "string" ? opts.branchName.trim() : "";

  if (opts.kind === "assigned") {
    return fmt(
      [
        "### ✅ 已分配执行者",
        "",
        `- 执行者：**${agentName}**`,
        roleKey ? `- 角色：\`${roleKey}\`` : "",
        `- Run：\`${runId}\``,
        "- 状态：已分配，正在创建工作区并准备开始执行",
        "",
        "> 由 ACP 协作台自动分配",
      ].join("\n"),
    );
  }

  return fmt(
    [
      "### 🚀 开始执行",
      "",
      `- 执行者：**${agentName}**`,
      roleKey ? `- 角色：\`${roleKey}\`` : "",
      `- Run：\`${runId}\``,
      branchName ? `- 分支：\`${branchName}\`` : "",
      "",
      "> 由 ACP 协作台自动触发执行",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function renderGitHubIssueComment(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  kind: CommentKind;
  agentName: string;
  roleKey?: string | null;
  runId: string;
  branchName?: string | null;
}): Promise<string> {
  const fallback = renderGitHubIssueCommentFallback(opts);
  const prisma = opts.prisma;
  if (!prisma) return fallback;

  const templateKey = opts.kind === "assigned" ? "github.issueComment.assigned" : "github.issueComment.started";
  const body = await renderTextTemplateFromDb(
    { prisma },
    {
      key: templateKey,
      projectId: opts.projectId ?? null,
      vars: {
        agentName: String(opts.agentName ?? "").trim() || "unknown",
        roleKey: typeof opts.roleKey === "string" ? opts.roleKey.trim() : "",
        runId: String(opts.runId ?? "").trim() || "unknown",
        branchName: typeof opts.branchName === "string" ? opts.branchName.trim() : "",
      },
      missingText: fallback,
    },
  );

  return fmt(body);
}

export async function postGitHubIssueCommentBestEffort(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  repoUrl: string;
  githubAccessToken: string;
  issueNumber: number;
  kind: CommentKind;
  agentName: string;
  roleKey?: string | null;
  runId: string;
  branchName?: string | null;
}): Promise<void> {
  const repoUrl = String(opts.repoUrl ?? "").trim();
  const token = String(opts.githubAccessToken ?? "").trim();
  const issueNumber = opts.issueNumber;
  if (!repoUrl || !token) return;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return;

  const parsed = github.parseGitHubRepo(repoUrl);
  if (!parsed) return;

  const auth: github.GitHubAuth = {
    apiBaseUrl: parsed.apiBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: token,
  };

  const body = await renderGitHubIssueComment({
    prisma: opts.prisma,
    projectId: opts.projectId ?? null,
    kind: opts.kind,
    agentName: opts.agentName,
    roleKey: opts.roleKey,
    runId: opts.runId,
    branchName: opts.branchName,
  });

  try {
    await github.createIssueComment(auth, { issueNumber, body });
  } catch {
    // best-effort：评论失败不阻塞主流程
  }
}

export async function renderGitHubApprovalComment(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  kind: ApprovalCommentKind;
  runId: string;
  approvalId: string;
  actor?: string | null;
  prUrl?: string | null;
  reason?: string | null;
  error?: string | null;
}): Promise<string> {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const approvalId = String(opts.approvalId ?? "").trim() || "unknown";
  const actor = String(opts.actor ?? "").trim() || "unknown";
  const prUrl = typeof opts.prUrl === "string" ? opts.prUrl.trim() : "";
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  const error = typeof opts.error === "string" ? opts.error.trim() : "";

  const fallback = fmt(
    [
      "### 🛡️ 审批状态更新",
      "",
      `- 动作：${opts.kind}`,
      `- 审批人：**${actor}**`,
      `- Run：\`${runId}\``,
      prUrl ? `- PR：${prUrl}` : "",
      `- 审批单：\`${approvalId}\``,
      reason ? `- 原因：${reason}` : "",
      error ? `- 错误：${error}` : "",
      "",
      "> 由 ACP 协作台回写",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const prisma = opts.prisma;
  if (!prisma) return fallback;

  const body = await renderTextTemplateFromDb(
    { prisma },
    {
      key: `github.approvalComment.${String(opts.kind)}`,
      projectId: opts.projectId ?? null,
      vars: { runId, approvalId, actor, prUrl, reason, error },
      missingText: fallback,
    },
  );

  return fmt(body);
}

export async function postGitHubApprovalCommentBestEffort(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  repoUrl: string;
  githubAccessToken: string;
  issueNumber: number;
  kind: ApprovalCommentKind;
  runId: string;
  approvalId: string;
  actor?: string | null;
  prUrl?: string | null;
  reason?: string | null;
  error?: string | null;
}): Promise<void> {
  const repoUrl = String(opts.repoUrl ?? "").trim();
  const token = String(opts.githubAccessToken ?? "").trim();
  const issueNumber = opts.issueNumber;
  if (!repoUrl || !token) return;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return;

  const parsed = github.parseGitHubRepo(repoUrl);
  if (!parsed) return;

  const auth: github.GitHubAuth = {
    apiBaseUrl: parsed.apiBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: token,
  };

  const body = await renderGitHubApprovalComment({
    prisma: opts.prisma,
    projectId: opts.projectId ?? null,
    kind: opts.kind,
    runId: opts.runId,
    approvalId: opts.approvalId,
    actor: opts.actor,
    prUrl: opts.prUrl,
    reason: opts.reason,
    error: opts.error,
  });

  try {
    await github.createIssueComment(auth, { issueNumber, body });
  } catch {
    // best-effort：评论失败不阻塞主流程
  }
}

export async function renderGitHubPrCreatedComment(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  runId: string;
  prUrl: string;
  provider?: PrCommentProvider | null;
  sourceBranch?: string | null;
  targetBranch?: string | null;
}): Promise<string> {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const prUrl = String(opts.prUrl ?? "").trim();
  const provider = String(opts.provider ?? "").trim().toLowerCase();
  const providerLabel = provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "SCM";
  const sourceBranch = typeof opts.sourceBranch === "string" ? opts.sourceBranch.trim() : "";
  const targetBranch = typeof opts.targetBranch === "string" ? opts.targetBranch.trim() : "";

  const fallback = fmt(
    [
      "### 🔗 已创建 PR",
      "",
      "- 动作：创建 PR",
      `- Run：\`${runId}\``,
      prUrl ? `- PR：${prUrl}` : "",
      `- 平台：${providerLabel}`,
      sourceBranch && targetBranch ? `- 分支：\`${sourceBranch}\` → \`${targetBranch}\`` : "",
      "",
      "> 由 ACP 协作台创建（best-effort 回写）",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const prisma = opts.prisma;
  if (!prisma) return fallback;

  const body = await renderTextTemplateFromDb(
    { prisma },
    {
      key: "github.prCreatedComment",
      projectId: opts.projectId ?? null,
      vars: { runId, prUrl, providerLabel, sourceBranch, targetBranch },
      missingText: fallback,
    },
  );

  return fmt(body);
}

export async function postGitHubPrCreatedCommentBestEffort(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  repoUrl: string;
  githubAccessToken: string;
  issueNumber: number;
  runId: string;
  prUrl: string;
  provider?: PrCommentProvider | null;
  sourceBranch?: string | null;
  targetBranch?: string | null;
}): Promise<void> {
  const repoUrl = String(opts.repoUrl ?? "").trim();
  const token = String(opts.githubAccessToken ?? "").trim();
  const issueNumber = opts.issueNumber;
  if (!repoUrl || !token) return;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return;

  const parsed = github.parseGitHubRepo(repoUrl);
  if (!parsed) return;

  const auth: github.GitHubAuth = {
    apiBaseUrl: parsed.apiBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: token,
  };

  const body = await renderGitHubPrCreatedComment({
    prisma: opts.prisma,
    projectId: opts.projectId ?? null,
    runId: opts.runId,
    prUrl: opts.prUrl,
    provider: opts.provider,
    sourceBranch: opts.sourceBranch,
    targetBranch: opts.targetBranch,
  });

  try {
    await github.createIssueComment(auth, { issueNumber, body });
  } catch {
    // best-effort：评论失败不阻塞主流程
  }
}

export async function renderGitHubAutoReviewComment(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  runId: string;
  prUrl?: string | null;
  changedFiles?: number | null;
  ciPassed?: boolean | null;
  sensitiveHits?: number | null;
  nextAction?: AutoReviewNextAction | string | null;
  reason?: string | null;
}): Promise<string> {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const prUrl = typeof opts.prUrl === "string" ? opts.prUrl.trim() : "";
  const changedFiles = Number.isFinite(opts.changedFiles as any) ? Number(opts.changedFiles) : null;
  const ciPassed = typeof opts.ciPassed === "boolean" ? opts.ciPassed : null;
  const sensitiveHits = Number.isFinite(opts.sensitiveHits as any) ? Number(opts.sensitiveHits) : null;
  const nextAction = typeof opts.nextAction === "string" ? String(opts.nextAction).trim() : "";
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";

  const ciText = ciPassed === null ? "⏳ 未知/未运行" : ciPassed ? "✅ 通过" : "❌ 失败";
  const changedFilesText = changedFiles === null ? "" : String(changedFiles);
  const sensitiveText =
    sensitiveHits === null ? "" : sensitiveHits > 0 ? `⚠️ 命中 ${sensitiveHits} 个文件` : "无";

  const fallback = fmt(
    [
      "### 🧾 自动验收摘要",
      "",
      `- Run：\`${runId}\``,
      prUrl ? `- PR：${prUrl}` : "",
      changedFiles === null ? "" : `- 变更文件：${changedFiles}`,
      ciPassed === null ? "- 测试：⏳ 未知/未运行" : `- 测试：${ciPassed ? "✅ 通过" : "❌ 失败"}`,
      sensitiveHits === null ? "" : `- 敏感变更：${sensitiveHits > 0 ? `⚠️ 命中 ${sensitiveHits} 个文件` : "无"}`,
      nextAction ? `- 建议下一步：\`${nextAction}\`${reason ? `（${reason}）` : ""}` : "",
      "",
      "> 由 ACP 协作台自动生成（best-effort 回写）",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const prisma = opts.prisma;
  if (!prisma) return fallback;

  const body = await renderTextTemplateFromDb(
    { prisma },
    {
      key: "github.autoReviewComment",
      projectId: opts.projectId ?? null,
      vars: {
        runId,
        prUrl,
        changedFiles: changedFilesText,
        ciText,
        sensitiveText,
        nextAction,
        reason,
      },
      missingText: fallback,
    },
  );

  return fmt(body);
}

export async function postGitHubAutoReviewCommentBestEffort(opts: {
  prisma?: PrismaDeps;
  projectId?: string | null;
  repoUrl: string;
  githubAccessToken: string;
  issueNumber: number;
  runId: string;
  prUrl?: string | null;
  changedFiles?: number | null;
  ciPassed?: boolean | null;
  sensitiveHits?: number | null;
  nextAction?: AutoReviewNextAction | string | null;
  reason?: string | null;
}): Promise<void> {
  const repoUrl = String(opts.repoUrl ?? "").trim();
  const token = String(opts.githubAccessToken ?? "").trim();
  const issueNumber = opts.issueNumber;
  if (!repoUrl || !token) return;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return;

  const parsed = github.parseGitHubRepo(repoUrl);
  if (!parsed) return;

  const auth: github.GitHubAuth = {
    apiBaseUrl: parsed.apiBaseUrl,
    owner: parsed.owner,
    repo: parsed.repo,
    accessToken: token,
  };

  const body = await renderGitHubAutoReviewComment({
    prisma: opts.prisma,
    projectId: opts.projectId ?? null,
    runId: opts.runId,
    prUrl: opts.prUrl,
    changedFiles: opts.changedFiles,
    ciPassed: opts.ciPassed,
    sensitiveHits: opts.sensitiveHits,
    nextAction: opts.nextAction,
    reason: opts.reason,
  });

  try {
    await github.createIssueComment(auth, { issueNumber, body });
  } catch {
    // best-effort：评论失败不阻塞主流程
  }
}
