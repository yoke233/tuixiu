import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import * as github from "../integrations/github.js";
import { uuidv7 } from "../utils/uuid.js";
import type { AcpTunnel } from "../services/acpTunnel.js";
import { advanceTaskFromRunTerminal, setTaskBlockedFromRun } from "../services/taskProgress.js";
import { rollbackTaskToStep } from "../services/taskEngine.js";
import { triggerPmAutoAdvance } from "../services/pm/pmAutoAdvance.js";
import { triggerTaskAutoAdvance } from "../services/taskAutoAdvance.js";
import { isPmAutomationEnabled } from "../services/pm/pmLlm.js";
import { getPmPolicyFromBranchProtection } from "../services/pm/pmPolicy.js";

function getHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const key = name.toLowerCase();
  const v = (headers as any)[key] as unknown;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const first = v[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function normalizeGitHubLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label.trim();
      if (!label || typeof label !== "object") return null;
      const name = (label as any).name;
      return typeof name === "string" ? name.trim() : null;
    })
    .filter((x): x is string => Boolean(x));
}

function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyGitHubSignature(opts: { secret: string; rawBody: Buffer; signature256?: string }): boolean {
  const sig = (opts.signature256 ?? "").trim();
  if (!sig.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")}`;
  return safeTimingEqual(expected, sig);
}

function toRepoKey(parsed: github.ParsedGitHubRepo): string {
  return `${parsed.host.toLowerCase()}/${parsed.owner.toLowerCase()}/${parsed.repo.toLowerCase()}`;
}

export function makeGitHubWebhookRoutes(deps: {
  prisma: PrismaDeps;
  acp?: AcpTunnel;
  webhookSecret?: string;
  parseRepo?: typeof github.parseGitHubRepo;
  onIssueUpserted?: (issueId: string, reason: string) => void;
  broadcastToClients?: (payload: unknown) => void;
}): FastifyPluginAsync {
  return async (server) => {
    const parseRepo = deps.parseRepo ?? github.parseGitHubRepo;
    const webhookSecret = typeof deps.webhookSecret === "string" && deps.webhookSecret.trim() ? deps.webhookSecret.trim() : null;

    server.post(
      "/github",
      {
        // GitHub webhook 签名校验需要原始 body
        preParsing: (request: any, _reply: any, payload: any, done: any) => {
          const chunks: Buffer[] = [];
          payload.on("data", (chunk: Buffer) => chunks.push(chunk));
          payload.on("end", () => {
            const rawBody = Buffer.concat(chunks);
            request.rawBody = rawBody;
            done(null, Readable.from([rawBody]));
          });
          payload.on("error", (err: unknown) => done(err));
        }
      },
      async (request) => {
        const event = getHeader(request.headers as any, "x-github-event") ?? "";
        const signature256 = getHeader(request.headers as any, "x-hub-signature-256");

        const rawBody = (request as any).rawBody as Buffer | undefined;
        if (webhookSecret) {
          if (!rawBody || !Buffer.isBuffer(rawBody)) {
            return { success: false, error: { code: "NO_RAW_BODY", message: "无法读取 webhook 原始 body" } };
          }
          if (!verifyGitHubSignature({ secret: webhookSecret, rawBody, signature256 })) {
            return { success: false, error: { code: "BAD_SIGNATURE", message: "GitHub webhook 签名校验失败" } };
          }
        }

        if (event === "ping") {
          return { success: true, data: { ok: true, event: "ping" } };
        }

        const ciEvents = new Set(["workflow_run", "check_suite", "check_run"]);
        const prEvents = new Set(["pull_request", "pull_request_review"]);
        if (event !== "issues" && !ciEvents.has(event) && !prEvents.has(event)) {
          return { success: true, data: { ok: true, ignored: true, reason: "UNSUPPORTED_EVENT", event } };
        }

        if (ciEvents.has(event)) {
          const repoUrl =
            typeof (request.body as any)?.repository?.html_url === "string" ? String((request.body as any).repository.html_url) : "";

          const parsedRepo = parseRepo(repoUrl);
          if (!parsedRepo) {
            return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook repoUrl 解析 GitHub owner/repo" } };
          }
          const repoKey = toRepoKey(parsedRepo);

          const projects = await deps.prisma.project.findMany();
          const project =
            (projects as any[]).find((p) => {
              const pr = typeof p?.repoUrl === "string" ? parseRepo(p.repoUrl) : null;
              return pr ? toRepoKey(pr) === repoKey : false;
            }) ?? null;

          if (!project) {
            return {
              success: false,
              error: { code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project", details: parsedRepo.webBaseUrl }
            };
          }

          const branch =
            event === "workflow_run"
              ? String((request.body as any)?.workflow_run?.head_branch ?? "")
              : event === "check_suite"
                ? String((request.body as any)?.check_suite?.head_branch ?? "")
                : String((request.body as any)?.check_run?.check_suite?.head_branch ?? (request.body as any)?.check_run?.head_branch ?? "");

          const status =
            event === "workflow_run"
              ? String((request.body as any)?.workflow_run?.status ?? "")
              : event === "check_suite"
                ? String((request.body as any)?.check_suite?.status ?? "")
                : String((request.body as any)?.check_run?.status ?? "");

          const conclusion =
            event === "workflow_run"
              ? (request.body as any)?.workflow_run?.conclusion
              : event === "check_suite"
                ? (request.body as any)?.check_suite?.conclusion
                : (request.body as any)?.check_run?.conclusion;

          const headSha =
            event === "workflow_run"
              ? String((request.body as any)?.workflow_run?.head_sha ?? "")
              : event === "check_suite"
                ? String((request.body as any)?.check_suite?.head_sha ?? "")
                : String((request.body as any)?.check_run?.head_sha ?? (request.body as any)?.check_run?.check_suite?.head_sha ?? "");

          const pullRequests =
            event === "workflow_run"
              ? (request.body as any)?.workflow_run?.pull_requests
              : event === "check_suite"
                ? (request.body as any)?.check_suite?.pull_requests
                : (request.body as any)?.check_run?.check_suite?.pull_requests ?? (request.body as any)?.check_run?.pull_requests;

          const prNumbers = Array.isArray(pullRequests)
            ? pullRequests
                .map((pr: any) => Number(pr?.number ?? 0))
                .filter((n: number) => Number.isInteger(n) && n > 0)
            : [];

          const completed = String(status).toLowerCase() === "completed" || String((request.body as any)?.action ?? "") === "completed";
          if (!completed) {
            return { success: true, data: { ok: true, ignored: true, reason: "NOT_COMPLETED", event, branch } };
          }

          let run =
            branch
              ? await deps.prisma.run.findFirst({
                  where: { status: "waiting_ci", branchName: branch, issue: { projectId: project.id } } as any,
                  orderBy: { startedAt: "desc" },
                  select: { id: true, issueId: true, taskId: true, stepId: true },
                })
              : null;

          if (!run) {
            if (prNumbers.length > 0) {
              run = await deps.prisma.run
                .findFirst({
                  where: {
                    status: "waiting_ci",
                    scmProvider: "github",
                    scmPrNumber: { in: prNumbers },
                    issue: { projectId: project.id },
                  } as any,
                  orderBy: { startedAt: "desc" },
                  select: { id: true, issueId: true, taskId: true, stepId: true },
                })
                .catch(() => null);
            }

            if (!run && headSha) {
              run = await deps.prisma.run
                .findFirst({
                  where: {
                    status: "waiting_ci",
                    scmProvider: "github",
                    scmHeadSha: headSha,
                    issue: { projectId: project.id },
                  } as any,
                  orderBy: { startedAt: "desc" },
                  select: { id: true, issueId: true, taskId: true, stepId: true },
                })
                .catch(() => null);
            }
          }

          if (!run) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_RUN", branch, headSha, prNumbers } };
          }

          const passed = String(conclusion ?? "").toLowerCase() === "success";
          const scmCiStatus = passed ? "passed" : "failed";

          await deps.prisma.run
            .update({
              where: { id: run.id },
              data: {
                status: passed ? "completed" : "failed",
                completedAt: new Date(),
                scmProvider: "github",
                scmCiStatus,
                scmHeadSha: headSha || null,
                scmUpdatedAt: new Date(),
                ...(passed ? null : { failureReason: "ci_failed", errorMessage: `ci_failed: ${String(conclusion ?? "unknown")}` }),
              } as any,
            })
            .catch(() => {});

          await advanceTaskFromRunTerminal(
            { prisma: deps.prisma },
            run.id,
            passed ? "completed" : "failed",
            passed ? undefined : { errorMessage: `ci_failed: ${String(conclusion ?? "unknown")}` },
          ).catch(() => {});

          if ((run as any).taskId) {
            deps.broadcastToClients?.({
              type: "task_updated",
              issue_id: (run as any).issueId,
              task_id: (run as any).taskId,
              step_id: (run as any).stepId,
              run_id: run.id,
            });
          }

          triggerPmAutoAdvance(
            { prisma: deps.prisma },
            { runId: run.id, issueId: (run as any).issueId, trigger: "ci_completed" },
          );

          if ((run as any).taskId && deps.acp) {
            triggerTaskAutoAdvance(
              { prisma: deps.prisma, acp: deps.acp, broadcastToClients: deps.broadcastToClients },
              { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "ci_completed" },
            );
          }

          if (passed && isPmAutomationEnabled()) {
            const { policy } = getPmPolicyFromBranchProtection((project as any).branchProtection);
            const allowAutoMerge = (policy as any)?.automation?.autoMerge === true;
            const requireMergeApproval = Array.isArray((policy as any)?.approvals?.requireForActions)
              ? (policy as any).approvals.requireForActions.includes("merge_pr")
              : false;
            const mergeMethod =
              typeof (policy as any)?.automation?.mergeMethod === "string" ? String((policy as any).automation.mergeMethod) : "squash";
            const ciGate = (policy as any)?.automation?.ciGate !== false;

            const token = String((project as any)?.githubAccessToken ?? "").trim();
            const prNumber =
              prNumbers.length === 1
                ? prNumbers[0]
                : Number.isFinite((run as any)?.scmPrNumber)
                  ? Number((run as any).scmPrNumber)
                  : null;
            const prUrl = prNumber && parsedRepo.webBaseUrl ? `${parsedRepo.webBaseUrl}/pull/${prNumber}` : "";

            const canAutoMerge =
              allowAutoMerge &&
              !requireMergeApproval &&
              !!token &&
              !!prNumber &&
              (!ciGate || scmCiStatus === "passed") &&
              String((project as any)?.scmType ?? "").toLowerCase() === "github";

            if (canAutoMerge) {
              const auth: github.GitHubAuth = {
                apiBaseUrl: parsedRepo.apiBaseUrl,
                owner: parsedRepo.owner,
                repo: parsedRepo.repo,
                accessToken: token,
              };

              try {
                const res = await github.mergePullRequest(auth, {
                  pullNumber: prNumber,
                  mergeMethod: mergeMethod === "merge" || mergeMethod === "rebase" ? (mergeMethod as any) : "squash",
                });

                if (!res?.merged) {
                  throw new Error(`GITHUB_MERGE_NOT_MERGED ${String(res?.message ?? "").trim()}`.trim());
                }

                await deps.prisma.event
                  .create({
                    data: {
                      id: uuidv7(),
                      runId: run.id,
                      source: "system",
                      type: "pm.pr.auto_merge.executed",
                      payload: { prNumber, prUrl: prUrl || undefined, headSha, mergeMethod } as any,
                    } as any,
                  })
                  .catch(() => {});
              } catch (err) {
                const errorText = err instanceof Error ? err.message : String(err);
                await deps.prisma.event
                  .create({
                    data: {
                      id: uuidv7(),
                      runId: run.id,
                      source: "system",
                      type: "pm.pr.auto_merge.failed",
                      payload: { prNumber, prUrl: prUrl || undefined, headSha, mergeMethod, error: errorText } as any,
                    } as any,
                  })
                  .catch(() => {});

                const taskId = String((run as any)?.taskId ?? "").trim();
                if (taskId) {
                  const task = await deps.prisma.task
                    .findUnique({ where: { id: taskId }, include: { steps: { orderBy: { order: "asc" } } } as any })
                    .catch(() => null);
                  const steps = Array.isArray((task as any)?.steps) ? ((task as any).steps as any[]) : [];
                  const target = steps.find((s) => String(s?.kind ?? "") === "dev.implement") ?? steps[0] ?? null;
                  if (target) {
                    const existingParams =
                      target.params && typeof target.params === "object" && !Array.isArray(target.params) ? target.params : {};
                    const fixMessage = [
                      "自动合并失败，需要你修复后重新 push：",
                      prUrl ? `- PR：${prUrl}` : prNumber ? `- PR：#${prNumber}` : "",
                      headSha ? `- Head：${String(headSha).slice(0, 12)}` : "",
                      errorText ? `- 失败原因：${errorText}` : "",
                      "",
                      "建议处理：",
                      "- 拉取最新 base 分支并解决冲突（如有）",
                      "- 确保本地测试通过",
                      "- git push 更新该 PR 分支，等待 CI 再次通过",
                    ]
                      .filter(Boolean)
                      .join("\n");

                    await deps.prisma.step
                      .update({
                        where: { id: target.id },
                        data: {
                          params: {
                            ...existingParams,
                            feedback: { type: "auto_merge_failed", message: fixMessage, prNumber, prUrl, headSha, error: errorText },
                          } as any,
                        } as any,
                      })
                      .catch(() => {});

                    await rollbackTaskToStep({ prisma: deps.prisma }, taskId, { stepId: target.id }).catch(() => {});

                    await deps.prisma.event
                      .create({
                        data: {
                          id: uuidv7(),
                          runId: run.id,
                          source: "system",
                          type: "pm.pr.auto_merge.rolled_back",
                          payload: { taskId, stepId: target.id, reason: "auto_merge_failed" } as any,
                        } as any,
                      })
                      .catch(() => {});

                    if (deps.acp) {
                      triggerTaskAutoAdvance(
                        { prisma: deps.prisma, acp: deps.acp, broadcastToClients: deps.broadcastToClients },
                        { issueId: (run as any).issueId, taskId, trigger: "task_rolled_back" },
                      );
                    }
                  }
                }
              }
            }
          }

          return { success: true, data: { ok: true, handled: true, runId: run.id, passed } };
        }

        if (event === "pull_request") {
          const bodySchema = z
            .object({
              action: z.string().min(1),
              pull_request: z
                .object({
                  number: z.number().int().positive(),
                  html_url: z.string().min(1),
                  state: z.string().optional(),
                  title: z.string().optional(),
                  body: z.string().nullable().optional(),
                  merged: z.boolean().optional(),
                  merged_at: z.string().nullable().optional(),
                  head: z
                    .object({
                      ref: z.string().min(1),
                      sha: z.string().min(1),
                    })
                    .passthrough(),
                  base: z
                    .object({
                      ref: z.string().min(1),
                      sha: z.string().min(1).optional(),
                    })
                    .passthrough(),
                })
                .passthrough(),
              repository: z.object({ html_url: z.string().min(1) }),
            })
            .passthrough();

          let payload: z.infer<typeof bodySchema>;
          try {
            payload = bodySchema.parse(request.body ?? {});
          } catch (err) {
            return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
          }

          const repoParsed = parseRepo(payload.repository.html_url);
          if (!repoParsed) {
            return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook repoUrl 解析 GitHub owner/repo" } };
          }
          const repoKey = toRepoKey(repoParsed);

          const projects = await deps.prisma.project.findMany();
          const project =
            (projects as any[]).find((p) => {
              const pr = typeof p?.repoUrl === "string" ? parseRepo(p.repoUrl) : null;
              return pr ? toRepoKey(pr) === repoKey : false;
            }) ?? null;

          if (!project) {
            return {
              success: false,
              error: { code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project", details: repoParsed.webBaseUrl },
            };
          }

          const prNumber = payload.pull_request.number;
          const headRef = payload.pull_request.head.ref;
          const headSha = payload.pull_request.head.sha;
          const prUrl = payload.pull_request.html_url;
          const prState = typeof payload.pull_request.state === "string" ? payload.pull_request.state : "";
          const merged =
            typeof payload.pull_request.merged === "boolean"
              ? payload.pull_request.merged
              : Boolean(payload.pull_request.merged_at);

          const resolvedRun =
            (await deps.prisma.run
              .findFirst({
                where: {
                  scmProvider: "github",
                  scmPrNumber: prNumber,
                  issue: { projectId: project.id },
                } as any,
                orderBy: { startedAt: "desc" },
                select: { id: true, issueId: true, taskId: true } as any,
              })
              .catch(() => null)) ??
            (await deps.prisma.run
              .findFirst({
                where: { branchName: headRef, issue: { projectId: project.id } } as any,
                orderBy: { startedAt: "desc" },
                select: { id: true, issueId: true, taskId: true } as any,
              })
              .catch(() => null)) ??
            (headSha
              ? await deps.prisma.run
                  .findFirst({
                    where: {
                      scmProvider: "github",
                      scmHeadSha: headSha,
                      issue: { projectId: project.id },
                    } as any,
                    orderBy: { startedAt: "desc" },
                    select: { id: true, issueId: true, taskId: true } as any,
                  })
                  .catch(() => null)
              : null);

          if (!resolvedRun) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_RUN", prNumber, headRef, headSha } };
          }

          const action = String(payload.action ?? "").trim().toLowerCase();
          const normalizedPrState = merged
            ? "merged"
            : String(prState ?? "")
                .trim()
                .toLowerCase() === "open"
              ? "open"
              : String(prState ?? "")
                  .trim()
                  .toLowerCase() === "closed"
                ? "closed"
                : null;

          await deps.prisma.run
            .update({
              where: { id: (resolvedRun as any).id },
              data: {
                scmProvider: "github",
                scmPrNumber: prNumber,
                scmPrUrl: prUrl || null,
                scmPrState: normalizedPrState,
                scmHeadSha: headSha || null,
                scmUpdatedAt: new Date(),
              } as any,
            })
            .catch(() => {});

          if (merged && action === "closed") {
            const taskId = String((resolvedRun as any)?.taskId ?? "").trim();
            const issueId = String((resolvedRun as any)?.issueId ?? "").trim();
            if (taskId) {
              const runs = await deps.prisma.run
                .findMany({
                  where: {
                    taskId,
                    status: "running",
                    executorType: "human",
                    branchName: headRef,
                    step: { is: { kind: "pr.merge" } } as any,
                  } as any,
                  select: { id: true, issueId: true, taskId: true, stepId: true },
                })
                .catch(() => []);

              let updatedCount = 0;
              for (const r of runs as any[]) {
                await deps.prisma.run
                  .update({ where: { id: r.id }, data: { status: "completed", completedAt: new Date() } as any })
                  .then(() => {
                    updatedCount += 1;
                  })
                  .catch(() => {});
                await advanceTaskFromRunTerminal({ prisma: deps.prisma }, r.id, "completed").catch(() => {});
                deps.broadcastToClients?.({
                  type: "task_updated",
                  issue_id: r.issueId,
                  task_id: r.taskId,
                  step_id: r.stepId ?? undefined,
                  run_id: r.id,
                  reason: "github_pull_request_merged",
                });
              }

              if (updatedCount === 0) {
                const task = await deps.prisma.task
                  .findUnique({
                    where: { id: taskId },
                    include: { steps: { orderBy: { order: "asc" } } } as any,
                  })
                  .catch(() => null);
                const steps = Array.isArray((task as any)?.steps) ? ((task as any).steps as any[]) : [];
                const currentStepId = String((task as any)?.currentStepId ?? "").trim();
                const current = steps.find((s) => String(s?.id ?? "") === currentStepId) ?? null;
                if (current && String(current.kind ?? "") === "pr.merge") {
                  await deps.prisma.step
                    .update({ where: { id: current.id }, data: { status: "completed" } as any })
                    .catch(() => {});
                  await deps.prisma.task.update({ where: { id: taskId }, data: { status: "completed" } as any }).catch(() => {});
                  if (issueId) {
                    await deps.prisma.issue.update({ where: { id: issueId }, data: { status: "done" } as any }).catch(() => {});
                  }
                  await deps.prisma.event
                    .create({
                      data: {
                        id: uuidv7(),
                        runId: (resolvedRun as any).id,
                        source: "system",
                        type: "github.pr.merged",
                        payload: { prNumber, headSha } as any,
                      } as any,
                    })
                    .catch(() => {});
                  deps.broadcastToClients?.({
                    type: "task_updated",
                    issue_id: issueId,
                    task_id: taskId,
                    reason: "github_pull_request_merged",
                  });
                }
              }
            }
          } else if (action === "synchronize") {
            const taskId = String((resolvedRun as any)?.taskId ?? "").trim();
            if (taskId) {
              const task = await deps.prisma.task
                .findUnique({
                  where: { id: taskId },
                  include: { steps: { orderBy: { order: "asc" } } } as any,
                })
                .catch(() => null);
              if (task && String((task as any).status ?? "") === "blocked") {
                const steps = Array.isArray((task as any).steps) ? ((task as any).steps as any[]) : [];
                const target = steps.find((s) => String(s?.kind ?? "") === "dev.implement") ?? steps[0] ?? null;
                if (target) {
                  await rollbackTaskToStep({ prisma: deps.prisma }, taskId, { stepId: target.id }).catch(() => {});
                  await deps.prisma.event
                    .create({
                      data: {
                        id: uuidv7(),
                        runId: (resolvedRun as any).id,
                        source: "system",
                        type: "github.pr.synchronize.rollback",
                        payload: { prNumber, headSha, taskId, stepId: target.id } as any,
                      } as any,
                    })
                    .catch(() => {});
                  deps.broadcastToClients?.({
                    type: "task_updated",
                    issue_id: (task as any).issueId,
                    task_id: taskId,
                    step_id: target.id,
                    reason: "github_pull_request_synchronize",
                  });
                }
              }
            }
          }

          return {
            success: true,
            data: { ok: true, handled: true, event: "pull_request", action: payload.action, prNumber, merged, headSha },
          };
        }

        if (event === "pull_request_review") {
          const bodySchema = z
            .object({
              action: z.string().min(1),
              review: z
                .object({
                  state: z.string().optional(),
                  body: z.string().nullable().optional(),
                })
                .passthrough(),
              pull_request: z
                .object({
                  number: z.number().int().positive(),
                  html_url: z.string().min(1),
                  head: z
                    .object({
                      ref: z.string().min(1),
                      sha: z.string().min(1),
                    })
                    .passthrough(),
                  base: z
                    .object({
                      ref: z.string().min(1),
                    })
                    .passthrough(),
                })
                .passthrough(),
              repository: z.object({ html_url: z.string().min(1) }),
            })
            .passthrough();

          let payload: z.infer<typeof bodySchema>;
          try {
            payload = bodySchema.parse(request.body ?? {});
          } catch (err) {
            return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
          }

          const repoParsed = parseRepo(payload.repository.html_url);
          if (!repoParsed) {
            return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook repoUrl 解析 GitHub owner/repo" } };
          }
          const repoKey = toRepoKey(repoParsed);

          const projects = await deps.prisma.project.findMany();
          const project =
            (projects as any[]).find((p) => {
              const pr = typeof p?.repoUrl === "string" ? parseRepo(p.repoUrl) : null;
              return pr ? toRepoKey(pr) === repoKey : false;
            }) ?? null;

          if (!project) {
            return {
              success: false,
              error: { code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project", details: repoParsed.webBaseUrl },
            };
          }

          const prNumber = payload.pull_request.number;
          const reviewState = String(payload.review?.state ?? "").trim().toLowerCase();
          const headRef = payload.pull_request.head.ref;
          const headSha = payload.pull_request.head.sha;
          const prUrl = payload.pull_request.html_url;

          const resolvedRun =
            (await deps.prisma.run
              .findFirst({
                where: {
                  scmProvider: "github",
                  scmPrNumber: prNumber,
                  issue: { projectId: project.id },
                } as any,
                orderBy: { startedAt: "desc" },
                select: { id: true, issueId: true, taskId: true } as any,
              })
              .catch(() => null)) ??
            (await deps.prisma.run
              .findFirst({
                where: { branchName: headRef, issue: { projectId: project.id } } as any,
                orderBy: { startedAt: "desc" },
                select: { id: true, issueId: true, taskId: true } as any,
              })
              .catch(() => null)) ??
            (headSha
              ? await deps.prisma.run
                  .findFirst({
                    where: {
                      scmProvider: "github",
                      scmHeadSha: headSha,
                      issue: { projectId: project.id },
                    } as any,
                    orderBy: { startedAt: "desc" },
                    select: { id: true, issueId: true, taskId: true } as any,
                  })
                  .catch(() => null)
              : null);

          if (!resolvedRun) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_RUN", prNumber, reviewState } };
          }

          await deps.prisma.run
            .update({
              where: { id: (resolvedRun as any).id },
              data: {
                scmProvider: "github",
                scmPrNumber: prNumber,
                scmPrUrl: prUrl || null,
                scmHeadSha: headSha || null,
                scmUpdatedAt: new Date(),
              } as any,
            })
            .catch(() => {});

          const action = String(payload.action ?? "").trim().toLowerCase();
          if (action === "submitted" && reviewState === "changes_requested") {
            const taskId = String((resolvedRun as any)?.taskId ?? "").trim();
            const issueId = String((resolvedRun as any)?.issueId ?? "").trim();

            const comment = typeof payload.review?.body === "string" ? payload.review.body.trim() : "";
            const reason = { code: "CHANGES_REQUESTED", message: comment || "changes requested" };

            if (taskId) {
              const activeRun = await deps.prisma.run
                .findFirst({
                  where: {
                    taskId,
                    branchName: headRef,
                    status: { in: ["running", "waiting_ci"] } as any,
                  } as any,
                  orderBy: { startedAt: "desc" },
                  select: { id: true } as any,
                })
                .catch(() => null);

              const runId = String((activeRun as any)?.id ?? (resolvedRun as any).id).trim();
              await setTaskBlockedFromRun({ prisma: deps.prisma }, runId, reason).catch(() => {});
              if (taskId && issueId) {
                deps.broadcastToClients?.({
                  type: "task_updated",
                  issue_id: issueId,
                  task_id: taskId,
                  run_id: runId,
                  reason: "github_pull_request_changes_requested",
                });
              }
            }
          }

          return {
            success: true,
            data: { ok: true, handled: true, event: "pull_request_review", action: payload.action, prNumber, reviewState },
          };
        }

        const bodySchema = z.object({
          action: z.string().min(1),
          issue: z
            .object({
              id: z.union([z.number(), z.string()]),
              number: z.number().int().positive(),
              title: z.string().min(1),
              body: z.string().nullable().optional(),
              state: z.string().optional(),
              html_url: z.string().min(1),
              labels: z.array(z.any()).optional(),
              pull_request: z.any().optional()
            }),
          repository: z
            .object({
              html_url: z.string().min(1)
            })
        });

        let payload: z.infer<typeof bodySchema>;
        try {
          payload = bodySchema.parse(request.body ?? {});
        } catch (err) {
          return { success: false, error: { code: "BAD_PAYLOAD", message: "Webhook payload 格式不合法", details: String(err) } };
        }

        if (payload.issue.pull_request) {
          return { success: true, data: { ok: true, ignored: true, reason: "IS_PULL_REQUEST" } };
        }

        const repoParsed = parseRepo(payload.repository.html_url);
        if (!repoParsed) {
          return { success: false, error: { code: "BAD_REPO_URL", message: "无法从 webhook repoUrl 解析 GitHub owner/repo" } };
        }
        const repoKey = toRepoKey(repoParsed);

        const projects = await deps.prisma.project.findMany();
        const project =
          (projects as any[]).find((p) => {
            const pr = typeof p?.repoUrl === "string" ? parseRepo(p.repoUrl) : null;
            return pr ? toRepoKey(pr) === repoKey : false;
          }) ?? null;

        if (!project) {
          return {
            success: false,
            error: { code: "NO_PROJECT", message: "未找到与该 GitHub 仓库匹配的 Project", details: repoParsed.webBaseUrl }
          };
        }

        const externalId = String(payload.issue.id);
        const existing = await deps.prisma.issue.findFirst({
          where: { projectId: project.id, externalProvider: "github", externalId }
        });

        const externalState = typeof payload.issue.state === "string" ? payload.issue.state : "";
        const externalLabels = normalizeGitHubLabels(payload.issue.labels);
        const lastSyncedAt = new Date();

        const shouldCreate = payload.action === "opened" || payload.action === "reopened";
        if (!existing && !shouldCreate) {
          return { success: true, data: { ok: true, ignored: true, reason: "NOT_OPEN_ACTION", action: payload.action } };
        }

        if (existing) {
          const nextStatus =
            payload.action === "reopened" && ["done", "failed", "cancelled"].includes((existing as any).status)
              ? "pending"
              : undefined;

          const updated = await deps.prisma.issue.update({
            where: { id: (existing as any).id },
            data: {
              title: payload.issue.title,
              description: payload.issue.body ?? null,
              ...(nextStatus ? { status: nextStatus as any } : null),
              externalNumber: payload.issue.number,
              externalUrl: payload.issue.html_url,
              externalState,
              externalLabels,
              lastSyncedAt
            } as any
          });

          deps.onIssueUpserted?.((updated as any).id, `github_webhook:${payload.action}`);
          return { success: true, data: { ok: true, projectId: project.id, issueId: (updated as any).id, created: false } };
        }

        try {
          const created = await deps.prisma.issue.create({
            data: {
              id: uuidv7(),
              projectId: project.id,
              title: payload.issue.title,
              description: payload.issue.body ?? null,
              status: "pending",
              externalProvider: "github",
              externalId,
              externalNumber: payload.issue.number,
              externalUrl: payload.issue.html_url,
              externalState,
              externalLabels,
              lastSyncedAt,
              createdBy: "github_webhook"
            } as any
          });

          deps.onIssueUpserted?.((created as any).id, `github_webhook:${payload.action}`);
          return { success: true, data: { ok: true, projectId: project.id, issueId: (created as any).id, created: true } };
        } catch (err) {
          const again = await deps.prisma.issue.findFirst({
            where: { projectId: project.id, externalProvider: "github", externalId }
          });
          if (again) {
            deps.onIssueUpserted?.((again as any).id, `github_webhook:${payload.action}`);
            return { success: true, data: { ok: true, projectId: project.id, issueId: (again as any).id, created: false } };
          }
          return { success: false, error: { code: "CREATE_FAILED", message: "写入 Issue 失败", details: String(err) } };
        }
      }
    );
  };
}
