import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import {
  parseApprovalContent,
  toApprovalSummary,
  withApprovalUpdate,
  type ApprovalStatus,
} from "../services/approvalRequests.js";
import { mergeReviewRequestForRun } from "../services/runReviewRequest.js";
import { postGitHubApprovalCommentBestEffort } from "../services/githubIssueComments.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";

import type * as gitlab from "../integrations/gitlab.js";
import type * as github from "../integrations/github.js";

const execFileAsync = promisify(execFile);

function normalizeApprovalStatus(value: string | undefined): ApprovalStatus | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  const allowed: ApprovalStatus[] = ["pending", "approved", "rejected", "executing", "executed", "failed"];
  return allowed.includes(v as ApprovalStatus) ? (v as ApprovalStatus) : null;
}

export function makeApprovalRoutes(deps: {
  prisma: PrismaDeps;
  gitPush?: (opts: { cwd: string; branch: string; project: any }) => Promise<void>;
  gitlab?: {
    inferBaseUrl?: typeof gitlab.inferGitlabBaseUrl;
    createMergeRequest?: typeof gitlab.createMergeRequest;
    mergeMergeRequest?: typeof gitlab.mergeMergeRequest;
    getMergeRequest?: typeof gitlab.getMergeRequest;
  };
  github?: {
    parseRepo?: typeof github.parseGitHubRepo;
    createPullRequest?: typeof github.createPullRequest;
    mergePullRequest?: typeof github.mergePullRequest;
    getPullRequest?: typeof github.getPullRequest;
  };
}): FastifyPluginAsync {
  return async (server) => {
    const gitPush =
      deps.gitPush ??
      (async (opts: { cwd: string; branch: string; project: any }) => {
        const { env, cleanup } = await createGitProcessEnv(opts.project);
        try {
          await execFileAsync("git", ["push", "-u", "origin", opts.branch], {
            cwd: opts.cwd,
            env,
          });
        } finally {
          await cleanup();
        }
      });

    server.get("/", async (request) => {
      const querySchema = z.object({
        status: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).default(50),
      });
      const { status, limit } = querySchema.parse(request.query);
      const wanted = normalizeApprovalStatus(status ?? undefined);

      const rows = await deps.prisma.artifact.findMany({
        where: { type: "report" as any },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { run: { include: { issue: true } } } as any,
      });

      const approvals = rows
        .map((a: any) => {
          const summary = toApprovalSummary(a, a?.run);
          return summary;
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x))
        .filter((x) => (wanted ? x.status === wanted : true));

      return { success: true, data: { approvals } };
    });

    server.post("/:id/approve", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        actor: z.string().min(1).max(100).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const { actor } = bodySchema.parse(request.body ?? {});

      const row = await deps.prisma.artifact.findUnique({ where: { id } });
      if (!row) {
        return { success: false, error: { code: "NOT_FOUND", message: "审批请求不存在" } };
      }
      const content = parseApprovalContent((row as any).content);
      if (!content) {
        return { success: false, error: { code: "NOT_APPROVAL", message: "该 Artifact 不是审批请求" } };
      }
      if (content.status !== "pending") {
        return { success: false, error: { code: "NOT_PENDING", message: "该审批请求不是 pending 状态" } };
      }
      if (content.action !== "merge_pr") {
        return { success: false, error: { code: "UNSUPPORTED_ACTION", message: "暂不支持该审批动作" } };
      }

      const now = new Date().toISOString();
      const decidedBy = typeof actor === "string" && actor.trim() ? actor.trim() : "user";
      const executing = withApprovalUpdate(content, { status: "executing", decidedBy, decidedAt: now });

      const run = await deps.prisma.run.findUnique({
        where: { id: (row as any).runId },
        include: { issue: { include: { project: true } }, artifacts: { orderBy: { createdAt: "desc" } } } as any,
      });
      if (!run) {
        return { success: false, error: { code: "NO_RUN", message: "找不到该审批对应的 Run" } };
      }

      const prArtifact = (run as any).artifacts?.find((a: any) => a?.type === "pr") ?? null;
      const prUrl =
        typeof prArtifact?.content?.webUrl === "string"
          ? String(prArtifact.content.webUrl).trim()
          : typeof prArtifact?.content?.web_url === "string"
            ? String(prArtifact.content.web_url).trim()
            : "";

      await deps.prisma.artifact.update({
        where: { id },
        data: { content: executing as any },
      });

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId: (row as any).runId,
            source: "system",
            type: "approval.merge_pr.approved",
            payload: { approvalId: id, decidedBy, decidedAt: now, prUrl: prUrl || undefined } as any,
          },
        })
        .catch(() => {});

      const issue: any = (run as any).issue;
      const project: any = issue?.project;
      const issueIsGitHub = String(issue?.externalProvider ?? "").toLowerCase() === "github";
      const issueNumber = Number(issue?.externalNumber ?? 0);
      const token = String(project?.githubAccessToken ?? "").trim();
      const repoUrl = String(project?.repoUrl ?? "").trim();

      if (issueIsGitHub && token) {
        await postGitHubApprovalCommentBestEffort({
          repoUrl,
          githubAccessToken: token,
          issueNumber,
          kind: "merge_pr_approved",
          runId: String((row as any).runId),
          approvalId: id,
          actor: decidedBy,
          prUrl: prUrl || null,
        });
      }

      const payload = (content as any)?.payload;
      const mergeBody = {
        squash: typeof payload?.squash === "boolean" ? payload.squash : undefined,
        mergeCommitMessage: typeof payload?.mergeCommitMessage === "string" ? payload.mergeCommitMessage : undefined,
      };

      const mergeRes = await mergeReviewRequestForRun(
        {
          prisma: deps.prisma,
          gitPush,
          gitlab: deps.gitlab,
          github: deps.github,
        },
        (row as any).runId,
        mergeBody,
      );

      const finalContent = mergeRes.success
        ? withApprovalUpdate(executing, { status: "executed", result: { ok: true, mergedAt: now } })
        : withApprovalUpdate(executing, {
            status: "failed",
            result: { ok: false, mergedAt: now, error: mergeRes.error },
          });

      const updatedApproval = await deps.prisma.artifact.update({
        where: { id },
        data: { content: finalContent as any },
      });

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId: (row as any).runId,
            source: "system",
            type: mergeRes.success ? "approval.merge_pr.executed" : "approval.merge_pr.failed",
            payload: mergeRes.success
              ? ({ approvalId: id, decidedBy, mergedAt: now, prUrl: prUrl || undefined } as any)
              : ({
                  approvalId: id,
                  decidedBy,
                  mergedAt: now,
                  prUrl: prUrl || undefined,
                  error: mergeRes.error,
                } as any),
          },
        })
        .catch(() => {});

      if (issueIsGitHub && token) {
        await postGitHubApprovalCommentBestEffort({
          repoUrl,
          githubAccessToken: token,
          issueNumber,
          kind: mergeRes.success ? "merge_pr_executed" : "merge_pr_failed",
          runId: String((row as any).runId),
          approvalId: id,
          actor: decidedBy,
          prUrl: prUrl || null,
          error: mergeRes.success ? null : String(mergeRes.error?.message ?? ""),
        });
      }

      const summary = toApprovalSummary(updatedApproval as any, run as any);
      if (!summary) {
        return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };
      }

      if (!mergeRes.success) {
        return { success: false, error: mergeRes.error, data: { approval: summary } };
      }

      return { success: true, data: { approval: summary, pr: (mergeRes as any).data?.pr } };
    });

    server.post("/:id/reject", async (request) => {
      const paramsSchema = z.object({ id: z.string().uuid() });
      const bodySchema = z.object({
        actor: z.string().min(1).max(100).optional(),
        reason: z.string().min(1).max(500).optional(),
      });
      const { id } = paramsSchema.parse(request.params);
      const { actor, reason } = bodySchema.parse(request.body ?? {});

      const row = await deps.prisma.artifact.findUnique({ where: { id } });
      if (!row) {
        return { success: false, error: { code: "NOT_FOUND", message: "审批请求不存在" } };
      }
      const content = parseApprovalContent((row as any).content);
      if (!content) {
        return { success: false, error: { code: "NOT_APPROVAL", message: "该 Artifact 不是审批请求" } };
      }
      if (content.status !== "pending") {
        return { success: false, error: { code: "NOT_PENDING", message: "该审批请求不是 pending 状态" } };
      }

      const now = new Date().toISOString();
      const decidedBy = typeof actor === "string" && actor.trim() ? actor.trim() : "user";
      const rejected = withApprovalUpdate(content, {
        status: "rejected",
        decidedBy,
        decidedAt: now,
        reason: typeof reason === "string" ? reason : content.reason,
      });

      const updated = await deps.prisma.artifact.update({ where: { id }, data: { content: rejected as any } });

      const run = await deps.prisma.run.findUnique({
        where: { id: (row as any).runId },
        include: { issue: { include: { project: true } }, artifacts: { orderBy: { createdAt: "desc" } } } as any,
      });
      if (!run) {
        return { success: false, error: { code: "NO_RUN", message: "找不到该审批对应的 Run" } };
      }

      const prArtifact = (run as any).artifacts?.find((a: any) => a?.type === "pr") ?? null;
      const prUrl =
        typeof prArtifact?.content?.webUrl === "string"
          ? String(prArtifact.content.webUrl).trim()
          : typeof prArtifact?.content?.web_url === "string"
            ? String(prArtifact.content.web_url).trim()
            : "";

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId: (row as any).runId,
            source: "system",
            type: "approval.merge_pr.rejected",
            payload: {
              approvalId: id,
              decidedBy,
              decidedAt: now,
              reason: rejected.reason ?? undefined,
              prUrl: prUrl || undefined,
            } as any,
          },
        })
        .catch(() => {});

      const issue: any = (run as any).issue;
      const project: any = issue?.project;
      const issueIsGitHub = String(issue?.externalProvider ?? "").toLowerCase() === "github";
      const issueNumber = Number(issue?.externalNumber ?? 0);
      const token = String(project?.githubAccessToken ?? "").trim();
      const repoUrl = String(project?.repoUrl ?? "").trim();

      if (issueIsGitHub && token) {
        await postGitHubApprovalCommentBestEffort({
          repoUrl,
          githubAccessToken: token,
          issueNumber,
          kind: "merge_pr_rejected",
          runId: String((row as any).runId),
          approvalId: id,
          actor: decidedBy,
          prUrl: prUrl || null,
          reason: typeof rejected.reason === "string" ? rejected.reason : null,
        });
      }

      const summary = toApprovalSummary(updated as any, run as any);
      if (!summary) {
        return { success: false, error: { code: "BAD_APPROVAL", message: "审批已更新但解析失败" } };
      }

      return { success: true, data: { approval: summary } };
    });
  };
}
