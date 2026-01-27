import * as github from "../integrations/github.js";

type CommentKind = "assigned" | "started";
type ApprovalCommentKind = "merge_pr_requested" | "merge_pr_approved" | "merge_pr_rejected" | "merge_pr_executed" | "merge_pr_failed";

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
