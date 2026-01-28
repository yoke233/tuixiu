import type { PrismaDeps } from "../../deps.js";
import { uuidv7 } from "../../utils/uuid.js";
import { postGitHubAutoReviewCommentBestEffort } from "../githubIssueComments.js";
import { getPmPolicyFromBranchProtection } from "./pmPolicy.js";

type NextAction = "create_pr" | "request_create_pr_approval" | "wait_ci" | "request_merge_approval" | "manual_review" | "none";

export type RunChangeFile = {
  path: string;
  status: string;
  oldPath?: string;
};

function buildMarkdown(opts: {
  runId: string;
  baseBranch: string;
  branch: string;
  files: RunChangeFile[];
  sensitive: { matchedFiles: string[]; patterns: string[] } | null;
  pr: { webUrl: string } | null;
  ci: { passed: boolean | null } | null;
  recommendation: { nextAction: NextAction; reason: string };
}): string {
  const lines: string[] = [];
  lines.push("# 自动验收报告");
  lines.push("");
  lines.push(`- Run：\`${opts.runId}\``);
  lines.push(`- 分支：\`${opts.baseBranch}...${opts.branch}\``);
  lines.push(`- 变更文件：${opts.files.length}`);
  if (opts.pr?.webUrl) lines.push(`- PR：${opts.pr.webUrl}`);
  if (opts.ci) lines.push(`- 测试：${opts.ci.passed === true ? "✅ 通过" : opts.ci.passed === false ? "❌ 失败" : "⏳ 未知/未运行"}`);
  if (opts.sensitive) lines.push(`- 敏感变更：⚠️ 命中 ${opts.sensitive.matchedFiles.length} 个文件`);
  lines.push("");

  if (opts.files.length) {
    lines.push("## 变更文件");
    lines.push("");
    for (const f of opts.files.slice(0, 60)) {
      lines.push(`- \`${f.status}\` ${f.oldPath ? `\`${f.oldPath}\` → ` : ""}\`${f.path}\``);
    }
    if (opts.files.length > 60) lines.push(`- …（其余 ${opts.files.length - 60} 个省略）`);
    lines.push("");
  }

  if (opts.sensitive) {
    lines.push("## 敏感目录命中");
    lines.push("");
    lines.push(`- patterns：${opts.sensitive.patterns.map((p) => `\`${p}\``).join(", ") || "（无）"}`);
    lines.push(`- files：${opts.sensitive.matchedFiles.map((p) => `\`${p}\``).join(", ") || "（无）"}`);
    lines.push("");
  }

  lines.push("## 建议下一步");
  lines.push("");
  lines.push(`- 动作：\`${opts.recommendation.nextAction}\``);
  lines.push(`- 原因：${opts.recommendation.reason}`);
  lines.push("");

  return lines.join("\n");
}

export async function autoReviewRunForPm(
  deps: { prisma: PrismaDeps },
  runId: string,
  opts?: { now?: () => Date; commentToGithub?: boolean },
): Promise<
  | { success: true; data: { runId: string; report: any } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const now = opts?.now ?? (() => new Date());

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      issue: { include: { project: true } },
    } as any,
  });
  if (!run) return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };

  const issue: any = (run as any).issue;
  const project: any = issue?.project;
  if (!issue || !project) return { success: false, error: { code: "BAD_RUN", message: "Run 缺少 issue/project" } };

  const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);

  const baseBranch = String(project.defaultBranch ?? "main");
  const branch = String((run as any).branchName ?? "");
  const files: RunChangeFile[] = [];
  const changesError: string | null = null;

  const prUrl = typeof (run as any).scmPrUrl === "string" ? String((run as any).scmPrUrl).trim() : "";
  const prState = typeof (run as any).scmPrState === "string" ? String((run as any).scmPrState).trim() : "";
  const prInfo = prUrl ? { webUrl: prUrl, state: prState || "open", mergeable: null, mergeableState: "" } : null;

  const ciStatus = typeof (run as any).scmCiStatus === "string" ? String((run as any).scmCiStatus).trim() : "";
  const ciPassed = ciStatus === "passed" ? true : ciStatus === "failed" ? false : null;
  const ciInfo = ciStatus ? { passed: ciPassed, summary: `scmCiStatus=${ciStatus}` } : null;

  const sensitive: { matchedFiles: string[]; patterns: string[] } | null = null;

  let nextAction: NextAction = "none";
  let nextReason = "无需动作";
  if (!prInfo) {
    const requireCreatePrApproval = policy.approvals.requireForActions.includes("create_pr");

    if (requireCreatePrApproval) {
      nextAction = "request_create_pr_approval";
      nextReason = "创建 PR 需要审批/人工确认后再继续";
    } else {
      nextAction = "create_pr";
      nextReason = "尚未发现 PR 交付物，建议先创建 PR 进入 Review/CI 流程";
    }
  } else if (!ciInfo || ciInfo.passed !== true) {
    nextAction = "wait_ci";
    nextReason = !ciInfo ? "尚未发现测试/CI 结果，建议先运行测试或等待 CI 回写" : "测试未通过，建议先修复并补测";
  } else if (
    policy.approvals.requireForActions.includes("merge_pr") ||
    (sensitive && policy.approvals.escalateOnSensitivePaths.includes("merge_pr"))
  ) {
    nextAction = "request_merge_approval";
    nextReason = "测试通过且已存在 PR；合并属于高危动作，建议发起合并审批/人工确认后合并";
  } else {
    nextAction = "manual_review";
    nextReason = "测试通过且已存在 PR；请人工 Review 后决定是否合并";
  }

  const markdown = buildMarkdown({
    runId,
    baseBranch,
    branch,
    files,
    sensitive,
    pr: prInfo ? { webUrl: prInfo.webUrl } : null,
    ci: ciInfo ? { passed: ciInfo.passed } : null,
    recommendation: { nextAction, reason: nextReason },
  });

  const report = {
    kind: "auto_review",
    version: 1,
    runId,
    createdAt: now().toISOString(),
    baseBranch,
    branch,
    changedFiles: files,
    pr: prInfo,
    ci: ciInfo,
    sensitive,
    changesError,
    recommendation: { nextAction, reason: nextReason },
    markdown,
  };

  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId,
        source: "system",
        type: "pm.auto_review.reported",
        payload: report as any,
      } as any,
    })
    .catch(() => {});

  const shouldComment = opts?.commentToGithub === true;
  if (shouldComment) {
    const already = await deps.prisma.event
      .findFirst({ where: { runId, type: "pm.auto_review.github_comment" }, orderBy: { timestamp: "desc" } })
      .catch(() => null);
    if (!already) {
      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId,
            source: "system",
            type: "pm.auto_review.github_comment",
            payload: { trigger: "auto_review" } as any,
          } as any,
        })
        .catch(() => {});

      const issueIsGitHub = String(issue?.externalProvider ?? "").toLowerCase() === "github";
      const issueNumber = Number(issue?.externalNumber ?? 0);
      const token = String(project?.githubAccessToken ?? "").trim();
      const repoUrlForIssue = String(issue?.externalUrl ?? project?.repoUrl ?? "").trim();

      if (issueIsGitHub && token) {
        await postGitHubAutoReviewCommentBestEffort({
          prisma: deps.prisma,
          projectId: issue?.projectId ?? null,
          repoUrl: repoUrlForIssue,
          githubAccessToken: token,
          issueNumber,
          runId,
          prUrl: prInfo?.webUrl ?? null,
          changedFiles: files.length,
          ciPassed: ciInfo?.passed ?? null,
          sensitiveHits: 0,
          nextAction: (report as any)?.recommendation?.nextAction ?? null,
          reason: (report as any)?.recommendation?.reason ?? null,
        });
      }
    }
  }

  return { success: true, data: { runId, report } };
}
