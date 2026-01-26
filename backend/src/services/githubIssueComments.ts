import * as github from "../integrations/github.js";

type CommentKind = "assigned" | "started";

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

