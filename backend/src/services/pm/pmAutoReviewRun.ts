import type { PrismaDeps } from "../../deps.js";
import { uuidv7 } from "../../utils/uuid.js";
import { getRunChanges, type RunChangeFile } from "../runGitChanges.js";
import { postGitHubAutoReviewCommentBestEffort } from "../githubIssueComments.js";
import { getPmPolicyFromBranchProtection } from "./pmPolicy.js";

type NextAction = "create_pr" | "wait_ci" | "request_merge_approval" | "manual_review" | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function globToRegExp(pattern: string): RegExp {
  // Very small glob subset:
  // - `**` matches any chars (including `/`)
  // - `*` matches any chars except `/`
  const raw = toPosixPath(pattern.trim());
  const escaped = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDoubleStar = escaped.replace(/\*\*/g, "§§DOUBLESTAR§§");
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  const final = withSingleStar.replace(/§§DOUBLESTAR§§/g, ".*");
  return new RegExp(`^${final}$`);
}

function matchAnyGlob(path: string, patterns: string[]): string[] {
  const p = toPosixPath(path);
  const matched: string[] = [];
  for (const raw of patterns) {
    const pat = String(raw ?? "").trim();
    if (!pat) continue;
    const re = globToRegExp(pat);
    if (re.test(p)) matched.push(pat);
  }
  return matched;
}

function normalizePrInfo(content: unknown): { webUrl: string; state: string; mergeable: boolean | null; mergeableState: string } | null {
  if (!isRecord(content)) return null;
  const webUrl =
    (typeof (content as any).webUrl === "string" && String((content as any).webUrl).trim()) ||
    (typeof (content as any).web_url === "string" && String((content as any).web_url).trim()) ||
    "";
  if (!webUrl) return null;
  const state = typeof (content as any).state === "string" ? String((content as any).state).trim() : "";
  const mergeable = typeof (content as any).mergeable === "boolean" ? (content as any).mergeable : null;
  const mergeableState =
    typeof (content as any).mergeable_state === "string" ? String((content as any).mergeable_state).trim() : "";
  return { webUrl, state, mergeable, mergeableState };
}

function normalizeCiResult(content: unknown): { passed: boolean | null; summary: string } | null {
  if (!isRecord(content)) return null;
  const passed = typeof (content as any).passed === "boolean" ? (content as any).passed : null;
  const summary =
    (typeof (content as any).summary === "string" && String((content as any).summary).trim()) ||
    (typeof (content as any).logExcerpt === "string" && String((content as any).logExcerpt).trim()) ||
    "";
  if (passed === null && !summary) return null;
  return { passed, summary };
}

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
  opts?: { now?: () => Date; getChanges?: typeof getRunChanges; commentToGithub?: boolean },
): Promise<
  | { success: true; data: { runId: string; artifactId: string; report: any } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const now = opts?.now ?? (() => new Date());
  const getChanges = opts?.getChanges ?? getRunChanges;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      issue: { include: { project: true } },
      artifacts: { orderBy: { createdAt: "desc" } },
    } as any,
  });
  if (!run) return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };

  const issue: any = (run as any).issue;
  const project: any = issue?.project;
  if (!issue || !project) return { success: false, error: { code: "BAD_RUN", message: "Run 缺少 issue/project" } };

  const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);
  const sensitivePatterns = Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [];

  let baseBranch = String(project.defaultBranch ?? "main");
  let branch = String((run as any).branchName ?? "");
  let files: RunChangeFile[] = [];
  let changesError: string | null = null;
  try {
    const changes = await getChanges({ prisma: deps.prisma, runId });
    baseBranch = changes.baseBranch;
    branch = changes.branch;
    files = changes.files;
  } catch (err) {
    changesError = err instanceof Error ? err.message : String(err);
  }

  const scopeWhere = (run as any).taskId
    ? ({ taskId: (run as any).taskId } as any)
    : ({ id: (run as any).id } as any);

  const [latestPr, latestCi] = await Promise.all([
    deps.prisma.artifact.findFirst({
      where: { type: "pr" as any, run: { is: scopeWhere } } as any,
      orderBy: { createdAt: "desc" },
    }),
    deps.prisma.artifact.findFirst({
      where: { type: "ci_result" as any, run: { is: scopeWhere } } as any,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const prInfo = latestPr ? normalizePrInfo((latestPr as any).content) : null;
  const ciInfo = latestCi ? normalizeCiResult((latestCi as any).content) : null;

  const matchedFiles: string[] = [];
  const matchedPatterns = new Set<string>();
  if (sensitivePatterns.length && files.length) {
    for (const f of files) {
      const pats = matchAnyGlob(f.path, sensitivePatterns);
      if (pats.length) {
        matchedFiles.push(f.path);
        for (const p of pats) matchedPatterns.add(p);
      }
    }
  }
  const sensitive = matchedFiles.length ? { matchedFiles, patterns: [...matchedPatterns] } : null;

  let nextAction: NextAction = "none";
  let nextReason = "无需动作";
  if (!prInfo) {
    if (changesError) {
      nextAction = "manual_review";
      nextReason = `尚未发现 PR；但获取变更失败（${changesError}），建议人工确认后再创建 PR`;
    } else if (files.length === 0) {
      nextAction = "none";
      nextReason = "未发现变更文件，无需创建 PR";
    } else {
      nextAction = "create_pr";
      nextReason = "尚未发现 PR 交付物，建议先创建 PR 进入 Review/CI 流程";
    }
  } else if (!ciInfo || ciInfo.passed !== true) {
    nextAction = "wait_ci";
    nextReason = !ciInfo ? "尚未发现测试/CI 结果，建议先运行测试或等待 CI 回写" : "测试未通过，建议先修复并补测";
  } else if (policy.approvals.requireForActions.includes("merge_pr")) {
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

  const artifact = await deps.prisma.artifact.create({
    data: {
      id: uuidv7(),
      runId,
      type: "report",
      content: report as any,
    } as any,
    select: { id: true } as any,
  });

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
          repoUrl: repoUrlForIssue,
          githubAccessToken: token,
          issueNumber,
          runId,
          prUrl: prInfo?.webUrl ?? null,
          changedFiles: files.length,
          ciPassed: ciInfo?.passed ?? null,
          sensitiveHits: sensitive?.matchedFiles?.length ?? 0,
          nextAction: (report as any)?.recommendation?.nextAction ?? null,
          reason: (report as any)?.recommendation?.reason ?? null,
        });
      }
    }
  }

  return { success: true, data: { runId, artifactId: (artifact as any).id, report } };
}
