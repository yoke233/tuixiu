import * as github from "../integrations/github.js";

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

function formatRole(roleKey?: string | null): string {
  const raw = typeof roleKey === "string" ? roleKey.trim() : "";
  return raw ? `\n- 角色：\`${raw}\`` : "";
}

function fmt(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function renderGitHubIssueComment(opts: {
  kind: CommentKind;
  agentName: string;
  roleKey?: string | null;
  runId: string;
  branchName?: string | null;
}): string {
  const agentName = String(opts.agentName ?? "").trim() || "unknown";
  const roleLine = formatRole(opts.roleKey);
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const branchName = typeof opts.branchName === "string" ? opts.branchName.trim() : "";

  if (opts.kind === "assigned") {
    return fmt(
      [
        "### ✅ 已分配执行者",
        "",
        `- 执行者：**${agentName}**${roleLine}`,
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
      `- 执行者：**${agentName}**${roleLine}`,
      `- Run：\`${runId}\``,
      branchName ? `- 分支：\`${branchName}\`` : "",
      "",
      "> 由 ACP 协作台自动触发执行",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function postGitHubIssueCommentBestEffort(opts: {
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

  const body = renderGitHubIssueComment({
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

export function renderGitHubApprovalComment(opts: {
  kind: ApprovalCommentKind;
  runId: string;
  approvalId: string;
  actor?: string | null;
  prUrl?: string | null;
  reason?: string | null;
  error?: string | null;
}): string {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const approvalId = String(opts.approvalId ?? "").trim() || "unknown";
  const actor = String(opts.actor ?? "").trim() || "unknown";
  const prUrl = typeof opts.prUrl === "string" ? opts.prUrl.trim() : "";
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
  const error = typeof opts.error === "string" ? opts.error.trim() : "";

  if (opts.kind === "create_pr_requested") {
    return fmt(
      [
        "### 🛡️ 已发起创建 PR 审批",
        "",
        "- 动作：创建 PR",
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        "- 状态：待审批",
        "",
        "> 由 ACP 协作台发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "create_pr_approved") {
    return fmt(
      [
        "### ✅ 审批通过，开始创建 PR",
        "",
        "- 动作：创建 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        "",
        "> 由 ACP 协作台创建 PR",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "create_pr_rejected") {
    return fmt(
      [
        "### ⛔ 审批被拒绝",
        "",
        "- 动作：创建 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        reason ? `- 原因：${reason}` : "",
        "",
        "> 如需继续，请重新发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "create_pr_executed") {
    return fmt(
      [
        "### 🎉 PR 已创建",
        "",
        "- 动作：创建 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        prUrl ? `- PR：${prUrl}` : "",
        `- 审批单：\`${approvalId}\``,
        "- 状态：已创建",
        "",
        "> 由 ACP 协作台完成创建",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "create_pr_failed") {
    return fmt(
      [
        "### ❌ 创建 PR 失败",
        "",
        "- 动作：创建 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        error ? `- 错误：${error}` : "",
        "",
        "> 请在协作台查看错误详情后重试",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "publish_artifact_requested") {
    return fmt(
      [
        "### 🛡️ 已发起发布交付物审批",
        "",
        "- 动作：发布交付物",
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        "- 状态：待审批",
        "",
        "> 由 ACP 协作台发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "publish_artifact_approved") {
    return fmt(
      [
        "### ✅ 审批通过，开始发布",
        "",
        "- 动作：发布交付物",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        "",
        "> 由 ACP 协作台执行发布",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "publish_artifact_rejected") {
    return fmt(
      [
        "### ⛔ 审批被拒绝",
        "",
        "- 动作：发布交付物",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        reason ? `- 原因：${reason}` : "",
        "",
        "> 如需继续，请重新发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "publish_artifact_executed") {
    return fmt(
      [
        "### 🎉 发布已完成",
        "",
        "- 动作：发布交付物",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        "- 状态：已发布",
        "",
        "> 由 ACP 协作台完成发布",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "publish_artifact_failed") {
    return fmt(
      [
        "### ❌ 发布执行失败",
        "",
        "- 动作：发布交付物",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        `- 审批单：\`${approvalId}\``,
        error ? `- 错误：${error}` : "",
        "",
        "> 请在协作台查看错误详情后重试",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "merge_pr_requested") {
    return fmt(
      [
        "### 🛡️ 已发起合并审批",
        "",
        "- 动作：合并 PR",
        `- Run：\`${runId}\``,
        prUrl ? `- PR：${prUrl}` : "",
        `- 审批单：\`${approvalId}\``,
        "- 状态：待审批",
        "",
        "> 由 ACP 协作台发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "merge_pr_approved") {
    return fmt(
      [
        "### ✅ 审批通过，开始合并",
        "",
        "- 动作：合并 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        prUrl ? `- PR：${prUrl}` : "",
        `- 审批单：\`${approvalId}\``,
        "",
        "> 由 ACP 协作台执行合并",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "merge_pr_rejected") {
    return fmt(
      [
        "### ⛔ 审批被拒绝",
        "",
        "- 动作：合并 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        prUrl ? `- PR：${prUrl}` : "",
        `- 审批单：\`${approvalId}\``,
        reason ? `- 原因：${reason}` : "",
        "",
        "> 如需继续，请重新发起审批",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (opts.kind === "merge_pr_executed") {
    return fmt(
      [
        "### 🎉 合并已完成",
        "",
        "- 动作：合并 PR",
        `- 审批人：**${actor}**`,
        `- Run：\`${runId}\``,
        prUrl ? `- PR：${prUrl}` : "",
        `- 审批单：\`${approvalId}\``,
        "- 状态：已合并",
        "",
        "> 由 ACP 协作台完成合并",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return fmt(
    [
      "### ❌ 合并执行失败",
      "",
      "- 动作：合并 PR",
      `- 审批人：**${actor}**`,
      `- Run：\`${runId}\``,
      prUrl ? `- PR：${prUrl}` : "",
      `- 审批单：\`${approvalId}\``,
      error ? `- 错误：${error}` : "",
      "",
      "> 请在协作台查看错误详情后重试",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

export async function postGitHubApprovalCommentBestEffort(opts: {
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

  const body = renderGitHubApprovalComment({
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

export function renderGitHubPrCreatedComment(opts: {
  runId: string;
  prUrl: string;
  provider?: PrCommentProvider | null;
  sourceBranch?: string | null;
  targetBranch?: string | null;
}): string {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const prUrl = String(opts.prUrl ?? "").trim();
  const provider = String(opts.provider ?? "").trim().toLowerCase();
  const providerLabel = provider === "github" ? "GitHub" : provider === "gitlab" ? "GitLab" : "SCM";
  const sourceBranch = typeof opts.sourceBranch === "string" ? opts.sourceBranch.trim() : "";
  const targetBranch = typeof opts.targetBranch === "string" ? opts.targetBranch.trim() : "";

  return fmt(
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
}

export async function postGitHubPrCreatedCommentBestEffort(opts: {
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

  const body = renderGitHubPrCreatedComment({
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

export function renderGitHubAutoReviewComment(opts: {
  runId: string;
  prUrl?: string | null;
  changedFiles?: number | null;
  ciPassed?: boolean | null;
  sensitiveHits?: number | null;
  nextAction?: AutoReviewNextAction | string | null;
  reason?: string | null;
}): string {
  const runId = String(opts.runId ?? "").trim() || "unknown";
  const prUrl = typeof opts.prUrl === "string" ? opts.prUrl.trim() : "";
  const changedFiles = Number.isFinite(opts.changedFiles as any) ? Number(opts.changedFiles) : null;
  const ciPassed = typeof opts.ciPassed === "boolean" ? opts.ciPassed : null;
  const sensitiveHits = Number.isFinite(opts.sensitiveHits as any) ? Number(opts.sensitiveHits) : null;
  const nextAction = typeof opts.nextAction === "string" ? String(opts.nextAction).trim() : "";
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";

  return fmt(
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
}

export async function postGitHubAutoReviewCommentBestEffort(opts: {
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

  const body = renderGitHubAutoReviewComment({
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
