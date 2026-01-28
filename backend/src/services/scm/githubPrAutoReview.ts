import { z } from "zod";

import type { PrismaDeps } from "../../deps.js";
import * as github from "../../integrations/github.js";
import { uuidv7 } from "../../utils/uuid.js";
import { parseEnvText } from "../../utils/envText.js";
import type { AcpTunnel } from "../acpTunnel.js";
import { extractAgentTextFromEvents, extractTaggedCodeBlock } from "../agentOutput.js";
import { callPmLlmJson, isPmLlmEnabled } from "../pm/pmLlm.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type QueueTask = () => Promise<void>;

type AutoReviewMode = "llm" | "acp";

function truthyEnv(value: string | undefined): boolean {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function normalizeAutoReviewMode(value: unknown): AutoReviewMode {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "acp" || v === "agent") return "acp";
  return "llm";
}

function getAutoReviewMode(): AutoReviewMode {
  return normalizeAutoReviewMode(process.env.GITHUB_PR_AUTO_REVIEW_MODE);
}

export function isGitHubPrAutoReviewEnabled(): boolean {
  if (!truthyEnv(process.env.GITHUB_PR_AUTO_REVIEW_ENABLED)) return false;
  const mode = getAutoReviewMode();
  if (mode === "llm") return isPmLlmEnabled();
  return true;
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

function toGitHubReviewEvent(verdict: "approve" | "changes_requested" | null): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (verdict === "approve") return "APPROVE";
  if (verdict === "changes_requested") return "REQUEST_CHANGES";
  return "COMMENT";
}

function renderReviewBody(opts: {
  prNumber: number;
  prUrl?: string;
  headSha: string;
  verdict: "approve" | "changes_requested" | null;
  markdown: string;
  note: string;
}): string {
  const lines: string[] = [];
  lines.push("### 🤖 自动代码评审（ACP 协作台）");
  lines.push("");
  lines.push(`- PR：#${opts.prNumber}${opts.prUrl ? `（${opts.prUrl}）` : ""}`);
  lines.push(`- Head：\`${opts.headSha.slice(0, 12)}\``);
  if (opts.verdict) lines.push(`- 结论：\`${opts.verdict}\``);
  lines.push("");
  lines.push(String(opts.markdown ?? "").trim());
  lines.push("");
  lines.push(`> 说明：${opts.note}`);
  return lines.filter(Boolean).join("\n");
}

const llmReviewSchema = z.object({
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

type NormalizedReview = {
  verdict: "approve" | "changes_requested" | null;
  findings: z.infer<typeof llmReviewSchema>["findings"];
  markdown: string;
};

const acpReviewSchema = z
  .object({
    verdict: z.enum(["approve", "changes_requested"]).nullable().optional(),
    findings: llmReviewSchema.shape.findings.optional(),
    markdown: z.string().optional(),
  })
  .passthrough();

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return typeof v === "string" ? v : "";
  });
}

async function selectAvailableAgent(prisma: PrismaDeps, preferredAgentId?: string | null, preferredSandboxProvider?: string | null) {
  const desiredProvider = String(preferredSandboxProvider ?? "").trim();
  const matchesProvider = (agent: any) =>
    desiredProvider &&
    agent &&
    typeof agent === "object" &&
    agent.capabilities &&
    typeof agent.capabilities === "object" &&
    (agent.capabilities as any).sandbox &&
    typeof (agent.capabilities as any).sandbox === "object" &&
    String((agent.capabilities as any).sandbox.provider ?? "") === desiredProvider;

  if (preferredAgentId) {
    const a = await prisma.agent.findUnique({ where: { id: preferredAgentId } }).catch(() => null);
    if (a && (a as any).status === "online" && (a as any).currentLoad < (a as any).maxConcurrentRuns) {
      return a;
    }
  }

  const agents = await prisma.agent.findMany({
    where: { status: "online" },
    orderBy: { createdAt: "asc" },
  });

  const available = (agents as any[]).filter((a) => Number(a.currentLoad) < Number(a.maxConcurrentRuns));
  if (!available.length) return null;

  if (desiredProvider) {
    return available.find(matchesProvider) ?? available[0] ?? null;
  }

  return available[0] ?? null;
}

async function runGitHubPrAutoReviewOnce(
  deps: {
    prisma: PrismaDeps;
    acp?: AcpTunnel;
    listPullRequestFiles?: typeof github.listPullRequestFiles;
    createPullRequestReview?: typeof github.createPullRequestReview;
    callLlmJson?: typeof callPmLlmJson;
  },
  opts: {
    prArtifactId: string;
    prNumber?: number;
    prUrl?: string | null;
    title?: string | null;
    body?: string | null;
    headSha: string;
    baseSha?: string | null;
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

  const lastHeadShaFromArtifact = String(content.lastAutoReviewHeadSha ?? "").trim();
  const lastHeadShaFromRun = String(((run as any)?.metadata as any)?.githubPrAutoReview?.lastHeadSha ?? "").trim();
  if ((lastHeadShaFromArtifact && lastHeadShaFromArtifact === headSha) || (lastHeadShaFromRun && lastHeadShaFromRun === headSha)) {
    return;
  }

  const prNumber = Number.isFinite(opts.prNumber as any) ? Number(opts.prNumber) : Number(content.number);
  if (!Number.isFinite(prNumber) || prNumber <= 0) return;

  const baseSha = String(opts.baseSha ?? (content as any).baseSha ?? "").trim();

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

  const createPullRequestReview = deps.createPullRequestReview ?? github.createPullRequestReview;
  const callLlm = deps.callLlmJson ?? callPmLlmJson;

  const prTitle = String(opts.title ?? content.title ?? "").trim();
  const prBody = String(opts.body ?? content.body ?? "").trim();
  const prUrl = String(opts.prUrl ?? content.webUrl ?? "").trim();
  const sourceBranch = String(opts.sourceBranch ?? content.sourceBranch ?? "").trim();
  const targetBranch = String(opts.targetBranch ?? content.targetBranch ?? "").trim();

  const mode = getAutoReviewMode();
  const shouldUseAcp = mode === "acp" && !!deps.acp;

  let review: NormalizedReview | null = null;
  let model: string | null = null;
  let agentRunId: string | null = null;
  let generationError: string | null = null;
  let note = "";

  if (shouldUseAcp) {
    const workspacePath = typeof run.workspacePath === "string" ? run.workspacePath.trim() : "";
    if (!workspacePath) {
      generationError = "NO_WORKSPACE";
    } else {
      const preferredAgentId = String(process.env.GITHUB_PR_AUTO_REVIEW_AGENT_ID ?? "").trim() || null;
      const preferredSandboxProvider = String(process.env.GITHUB_PR_AUTO_REVIEW_SANDBOX_PROVIDER ?? "").trim() || null;
      const agent = await selectAvailableAgent(deps.prisma, preferredAgentId, preferredSandboxProvider);
      if (!agent) {
        generationError = "NO_AGENT";
      } else {
        const roleKeyFromEnv = String(process.env.GITHUB_PR_AUTO_REVIEW_ROLE_KEY ?? "").trim();
        const roleKey = roleKeyFromEnv || "reviewer";
        const role = roleKey
          ? await deps.prisma.roleTemplate.findFirst({ where: { projectId: issue.projectId, key: roleKey } }).catch(() => null)
          : null;

        const created = await deps.prisma.run
          .create({
            data: {
              id: uuidv7(),
              issueId: issue.id,
              agentId: agent.id,
              executorType: "agent",
              taskId: run.taskId ?? null,
              stepId: null,
              status: "running",
              workspaceType: run.workspaceType ?? null,
              workspacePath,
              branchName: run.branchName ?? null,
              metadata: {
                kind: "github_pr_auto_review",
                prArtifactId: String((prArtifact as any).id),
                prNumber,
                headSha,
                baseSha: baseSha || null,
                roleKey: role ? String((role as any).key) : null,
                flags: { suppressIssueStatusUpdate: true, suppressPmAutoAdvance: true },
              } as any,
            } as any,
            select: { id: true } as any,
          })
          .catch(() => null);

        agentRunId = created ? String((created as any).id ?? "").trim() : null;

        if (!agentRunId) {
          generationError = "CREATE_RUN_FAILED";
        } else {
          await deps.prisma.agent.update({ where: { id: agent.id }, data: { currentLoad: { increment: 1 } } }).catch(() => {});

          const roleEnv = role?.envText ? parseEnvText(String(role.envText)) : {};
          const init =
            role?.initScript?.trim()
              ? {
                  script: String(role.initScript),
                  timeout_seconds: Number.isFinite(role.initTimeoutSeconds as any) ? role.initTimeoutSeconds : 300,
                  env: {
                    ...roleEnv,
                    ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}),
                    TUIXIU_PROJECT_ID: issue.projectId,
                    TUIXIU_PROJECT_NAME: String(project.name ?? ""),
                    TUIXIU_REPO_URL: String(project.repoUrl ?? ""),
                    TUIXIU_DEFAULT_BRANCH: String(project.defaultBranch ?? ""),
                    ...(role ? { TUIXIU_ROLE_KEY: String(role.key) } : {}),
                    TUIXIU_RUN_ID: agentRunId,
                    TUIXIU_WORKSPACE: workspacePath,
                    TUIXIU_PROJECT_HOME_DIR: `.tuixiu/projects/${issue.projectId}`,
                    TUIXIU_REVIEW_PR_NUMBER: String(prNumber),
                    TUIXIU_REVIEW_PR_URL: prUrl,
                    TUIXIU_REVIEW_HEAD_SHA: headSha,
                    TUIXIU_REVIEW_BASE_SHA: baseSha || "",
                    TUIXIU_REVIEW_BASE_BRANCH: targetBranch,
                    TUIXIU_REVIEW_HEAD_BRANCH: sourceBranch,
                  },
                }
              : undefined;

          const promptParts: string[] = [];
          promptParts.push(
            [
              "你正在进行一次只读的 Pull Request 自动评审：",
              `- workspace: ${workspacePath}`,
              "",
              "重要约束：不要修改/创建/删除任何文件；不要 git commit；不要 git push。只做阅读、运行只读命令、输出评审报告。",
            ].join("\n"),
          );

          if (role?.promptTemplate?.trim()) {
            const rendered = renderTemplate(String(role.promptTemplate), {
              workspace: workspacePath,
              branch: String(run.branchName ?? ""),
              repoUrl: String(project.repoUrl ?? ""),
              defaultBranch: String(project.defaultBranch ?? ""),
              "project.id": String(project.id ?? ""),
              "project.name": String(project.name ?? ""),
              "issue.id": String(issue.id ?? ""),
              "issue.title": String(issue.title ?? ""),
              "issue.description": String(issue.description ?? ""),
              roleKey: String(role.key),
              "role.key": String(role.key),
              "role.name": String(role.displayName ?? role.key),
            });
            promptParts.push(`角色指令:\n${rendered}`);
          }

          promptParts.push(
            [
              "任务：对该 Pull Request 的变更进行对抗式代码评审（默认更严格）。",
              prUrl ? `- PR：#${prNumber}（${prUrl}）` : `- PR：#${prNumber}`,
              targetBranch ? `- Base：${targetBranch}${baseSha ? `（${baseSha.slice(0, 12)}）` : ""}` : "",
              sourceBranch ? `- Head：${sourceBranch}（${headSha.slice(0, 12)}）` : `- Head：${headSha.slice(0, 12)}`,
              prTitle ? `- Title：${prTitle}` : "",
              prBody ? `- Description：\n${clampText(prBody, 4000)}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );

          promptParts.push(
            [
              "请先生成 diff 再评审：",
              "建议命令：",
              baseSha
                ? `- git diff ${baseSha}...${headSha}`
                : targetBranch
                  ? `- git diff origin/${targetBranch}...HEAD`
                  : "- git diff <base-branch>...HEAD",
              "",
              "如当前 Agent 是 Codex CLI 且支持内置 review preset（例如在 CLI 输入 `/review`，或使用 `codex review` 子命令），请优先使用该 preset 做审查（默认不触碰 working tree）。不可用则退化为基于 diff 的人工审查流程。",
              "",
              "要求：必须给出问题清单；若确实 0 findings，必须解释为什么确信没问题，并列出你检查过的项目（checks）。",
              "最后请输出一个代码块：```REPORT_JSON```，其内容必须是 JSON：",
              `- verdict: "approve" | "changes_requested"`,
              `- findings: { severity: "high"|"medium"|"low"; message: string; path?: string }[]`,
              `- markdown: string（评审报告 Markdown：结论、问题清单、风险、建议、证据）`,
            ].join("\n"),
          );

          try {
            await deps.acp!.promptRun({
              proxyId: String((agent as any).proxyId ?? ""),
              runId: agentRunId,
              cwd: workspacePath,
              sessionId: null,
              prompt: [{ type: "text", text: promptParts.join("\n\n") }],
              init,
            });

            const events = await deps.prisma.event
              .findMany({ where: { runId: agentRunId }, orderBy: { timestamp: "asc" }, take: 5000 })
              .catch(() => []);
            const agentText = extractAgentTextFromEvents(events as any[]);
            const jsonText = extractTaggedCodeBlock(agentText, "REPORT_JSON");

            let parsed: unknown = null;
            try {
              parsed = jsonText ? JSON.parse(jsonText) : null;
            } catch {
              parsed = null;
            }

            const zodRes = acpReviewSchema.safeParse(parsed);
            note = "评审由 ACP Agent 在本地 workspace 基于 `git diff` 生成，并回写为 GitHub PR Review。";

            const fallback = agentText.trim() ? agentText.trim() : "（无输出）";
            if (!zodRes.success) generationError = "BAD_REPORT_JSON";
            review = {
              verdict: zodRes.success ? (zodRes.data.verdict ?? null) : null,
              findings: zodRes.success ? (zodRes.data.findings ?? []) : [],
              markdown: zodRes.success && typeof zodRes.data.markdown === "string" && zodRes.data.markdown.trim() ? zodRes.data.markdown.trim() : clampText(fallback, 50_000),
            };
          } catch (err) {
            generationError = String(err);
            await deps.prisma.run
              .update({
                where: { id: agentRunId },
                data: { status: "failed", completedAt: new Date(), errorMessage: String(err) } as any,
              })
              .catch(() => {});
            await deps.prisma.agent.update({ where: { id: agent.id }, data: { currentLoad: { decrement: 1 } } }).catch(() => {});
          }
        }
      }
    }
  }

  if (!review) {
    if (mode === "acp") {
      if (generationError) {
        await deps.prisma.event
          .create({
            data: {
              id: uuidv7(),
              runId: run.id,
              source: "system",
              type: "github.pr.auto_review.skipped",
              payload: { prNumber, headSha, baseSha: baseSha || null, mode, reason: generationError, agentRunId } as any,
            } as any,
          })
          .catch(() => {});
      }
      return;
    }

    if (!isPmLlmEnabled()) return;

    const listPullRequestFiles = deps.listPullRequestFiles ?? github.listPullRequestFiles;

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
        baseSha ? `BASE_SHA: ${baseSha}` : "",
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
      schema: llmReviewSchema,
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

    review = {
      verdict: llm.value.verdict,
      findings: llm.value.findings ?? [],
      markdown: llm.value.markdown,
    };
    model = llm.model;
    note = "评审基于 GitHub PR files patch（可能被截断），仅供参考。";
  }

  if (!review) return;

  const normalized: NormalizedReview = {
    verdict: review.verdict ?? null,
    findings: review.findings ?? [],
    markdown: review.markdown,
  };

  await deps.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: run.id,
        source: "system",
        type: "github.pr.auto_review.reported",
        payload: {
          kind: "github_pr_auto_review",
          version: 3,
          provider: "github",
          prNumber,
          prUrl,
          headSha,
          baseSha: baseSha || null,
          verdict: normalized.verdict,
          findings: normalized.findings,
          markdown: normalized.markdown,
          model,
          agentRunId,
          generationError,
          createdAt: nowIso,
        } as any,
      } as any,
    })
    .catch(() => {});

  const body = renderReviewBody({
    prNumber,
    prUrl: prUrl || undefined,
    headSha,
    verdict: normalized.verdict ?? null,
    markdown: normalized.markdown,
    note: note || "自动评审（无说明）",
  });

  let reviewId: number | null = null;
  let reviewError: string | null = null;
  try {
    const prReview = await createPullRequestReview(auth, {
      pullNumber: prNumber,
      body: clampText(body, 60_000),
      event: toGitHubReviewEvent(normalized.verdict),
      commitId: headSha || undefined,
    });
    reviewId = typeof (prReview as any)?.id === "number" ? (prReview as any).id : null;
  } catch (err) {
    reviewError = String(err);
  }

  const prevMeta = run?.metadata && typeof run.metadata === "object" ? (run.metadata as any) : {};
  const prevAuto = prevMeta.githubPrAutoReview && typeof prevMeta.githubPrAutoReview === "object" ? (prevMeta.githubPrAutoReview as any) : {};
  await deps.prisma.run
    .update({
      where: { id: run.id } as any,
      data: {
        metadata: {
          ...prevMeta,
          githubPrAutoReview: {
            ...prevAuto,
            lastHeadSha: headSha,
            lastAt: nowIso,
            lastVerdict: normalized.verdict,
            lastAgentRunId: agentRunId,
            lastReviewId: reviewId,
            lastReviewError: reviewError,
          },
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
        type: reviewError ? "github.pr.auto_review.review_failed" : "github.pr.auto_review.reviewed",
        payload: {
          prNumber,
          headSha,
          baseSha: baseSha || null,
          verdict: normalized.verdict,
          reviewId,
          error: reviewError,
          agentRunId,
        } as any,
      } as any,
    })
    .catch(() => {});
}

const prQueue = new Map<string, Promise<void>>();

export function triggerGitHubPrAutoReview(
  deps: {
    prisma: PrismaDeps;
    acp?: AcpTunnel;
    listPullRequestFiles?: typeof github.listPullRequestFiles;
    createPullRequestReview?: typeof github.createPullRequestReview;
    callLlmJson?: typeof callPmLlmJson;
  },
  opts: {
    prArtifactId: string;
    prNumber?: number;
    prUrl?: string | null;
    title?: string | null;
    body?: string | null;
    headSha: string;
    baseSha?: string | null;
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
