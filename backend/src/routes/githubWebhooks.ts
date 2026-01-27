import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import * as github from "../integrations/github.js";
import { uuidv7 } from "../utils/uuid.js";
import { advanceTaskFromRunTerminal, setTaskBlockedFromRun } from "../services/taskProgress.js";
import { triggerGitHubPrAutoReview } from "../services/githubPrAutoReview.js";
import { rollbackTaskToStep } from "../services/taskEngine.js";
import { triggerPmAutoAdvance } from "../services/pm/pmAutoAdvance.js";
import { triggerTaskAutoAdvance } from "../services/taskAutoAdvance.js";

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

          const completed = String(status).toLowerCase() === "completed" || String((request.body as any)?.action ?? "") === "completed";
          if (!branch || !completed) {
            return { success: true, data: { ok: true, ignored: true, reason: "NOT_COMPLETED", event, branch } };
          }

          const run = await deps.prisma.run.findFirst({
            where: { status: "waiting_ci", branchName: branch, issue: { projectId: project.id } } as any,
            orderBy: { startedAt: "desc" },
            select: { id: true, issueId: true, taskId: true, stepId: true },
          });

          if (!run) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_RUN", branch } };
          }

          const passed = String(conclusion ?? "").toLowerCase() === "success";

          await deps.prisma.artifact
            .create({
              data: {
                id: uuidv7(),
                runId: run.id,
                type: "ci_result",
                content: { provider: "github", event, branch, status, conclusion, passed } as any,
              },
            })
            .catch(() => {});

          await deps.prisma.run
            .update({
              where: { id: run.id },
              data: {
                status: passed ? "completed" : "failed",
                completedAt: new Date(),
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

          if ((run as any).taskId) {
            triggerTaskAutoAdvance(
              { prisma: deps.prisma, broadcastToClients: deps.broadcastToClients },
              { issueId: (run as any).issueId, taskId: (run as any).taskId, trigger: "ci_completed" },
            );
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
          const prTitle = typeof payload.pull_request.title === "string" ? payload.pull_request.title : "";
          const merged =
            typeof payload.pull_request.merged === "boolean"
              ? payload.pull_request.merged
              : Boolean(payload.pull_request.merged_at);

          const prArtifact = await deps.prisma.artifact
            .findFirst({
              where: {
                type: "pr",
                run: { is: { issue: { is: { projectId: (project as any).id } } } } as any,
                AND: [
                  { content: { path: ["provider"], equals: "github" } as any },
                  { content: { path: ["number"], equals: prNumber } as any },
                ] as any,
              } as any,
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null);

          if (!prArtifact) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_PR_ARTIFACT", prNumber } };
          }

          const content = ((prArtifact as any).content ?? {}) as any;
          await deps.prisma.artifact
            .update({
              where: { id: (prArtifact as any).id },
              data: {
                content: {
                  ...content,
                  number: content.number ?? prNumber,
                  webUrl: content.webUrl ?? prUrl,
                  state: prState || content.state,
                  title: prTitle || content.title,
                  sourceBranch: headRef || content.sourceBranch,
                  headSha,
                  merged,
                  merged_at: payload.pull_request.merged_at ?? content.merged_at ?? null,
                  lastWebhookAt: new Date().toISOString(),
                } as any,
              } as any,
            })
            .catch(() => {});

          const action = String(payload.action ?? "").trim().toLowerCase();
          const isDraft = Boolean((payload.pull_request as any).draft);
          const shouldAutoReview =
            !merged &&
            (action === "opened" || action === "reopened" || action === "ready_for_review" || action === "synchronize") &&
            (!isDraft || action === "ready_for_review");
          if (shouldAutoReview) {
            triggerGitHubPrAutoReview(
              { prisma: deps.prisma },
              {
                prArtifactId: String((prArtifact as any).id),
                prNumber,
                prUrl,
                title: prTitle || null,
                body: typeof payload.pull_request.body === "string" ? payload.pull_request.body : null,
                headSha,
                sourceBranch: headRef,
                targetBranch: payload.pull_request.base.ref,
              },
            );
          }

          if (merged && String(payload.action ?? "").trim().toLowerCase() === "closed") {
            const prRun = await deps.prisma.run
              .findUnique({
                where: { id: (prArtifact as any).runId },
                select: { taskId: true, issueId: true } as any,
              })
              .catch(() => null);

            const taskId = String((prRun as any)?.taskId ?? "").trim();
            const issueId = String((prRun as any)?.issueId ?? "").trim();
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
                        runId: (prArtifact as any).runId,
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
          } else if (String(payload.action ?? "").trim().toLowerCase() === "synchronize") {
            const prRun = await deps.prisma.run
              .findUnique({
                where: { id: (prArtifact as any).runId },
                select: { taskId: true, issueId: true } as any,
              })
              .catch(() => null);
            const taskId = String((prRun as any)?.taskId ?? "").trim();
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
                        runId: (prArtifact as any).runId,
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

          const prArtifact = await deps.prisma.artifact
            .findFirst({
              where: {
                type: "pr",
                run: { is: { issue: { is: { projectId: (project as any).id } } } } as any,
                AND: [
                  { content: { path: ["provider"], equals: "github" } as any },
                  { content: { path: ["number"], equals: prNumber } as any },
                ] as any,
              } as any,
              orderBy: { createdAt: "desc" },
            })
            .catch(() => null);

          if (!prArtifact) {
            return { success: true, data: { ok: true, ignored: true, reason: "NO_PR_ARTIFACT", prNumber, reviewState } };
          }

          const content = ((prArtifact as any).content ?? {}) as any;
          await deps.prisma.artifact
            .update({
              where: { id: (prArtifact as any).id },
              data: {
                content: {
                  ...content,
                  headSha: payload.pull_request.head.sha,
                  sourceBranch: payload.pull_request.head.ref,
                  lastReviewState: reviewState,
                  lastReviewAt: new Date().toISOString(),
                } as any,
              } as any,
            })
            .catch(() => {});

          const action = String(payload.action ?? "").trim().toLowerCase();
          if (action === "submitted" && reviewState === "changes_requested") {
            const prRun = await deps.prisma.run
              .findUnique({
                where: { id: (prArtifact as any).runId },
                select: { taskId: true, issueId: true } as any,
              })
              .catch(() => null);
            const taskId = String((prRun as any)?.taskId ?? "").trim();
            const issueId = String((prRun as any)?.issueId ?? "").trim();

            const comment = typeof payload.review?.body === "string" ? payload.review.body.trim() : "";
            const reason = { code: "CHANGES_REQUESTED", message: comment || "changes requested" };

            if (taskId) {
              const activeRun = await deps.prisma.run
                .findFirst({
                  where: {
                    taskId,
                    branchName: payload.pull_request.head.ref,
                    status: { in: ["running", "waiting_ci"] } as any,
                  } as any,
                  orderBy: { startedAt: "desc" },
                  select: { id: true } as any,
                })
                .catch(() => null);

              const runId = String((activeRun as any)?.id ?? (prArtifact as any).runId).trim();
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
