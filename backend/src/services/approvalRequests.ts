import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { postGitHubApprovalCommentBestEffort } from "./githubIssueComments.js";

const approvalActionSchema = z.enum(["merge_pr"]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "executing", "executed", "failed"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalContentSchema = z.object({
  kind: z.literal("approval_request"),
  version: z.number().int().positive().default(1),
  action: approvalActionSchema,
  status: approvalStatusSchema,
  requestedBy: z.string().min(1).optional(),
  requestedAt: z.string().min(1).optional(),
  decidedBy: z.string().min(1).nullable().optional(),
  decidedAt: z.string().min(1).nullable().optional(),
  reason: z.string().nullable().optional(),
  payload: z.any().optional(),
  result: z.any().optional(),
});

export type ApprovalContent = z.infer<typeof approvalContentSchema>;

export type ApprovalSummary = {
  id: string;
  runId: string;
  createdAt: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  requestedBy: string | null;
  requestedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  issueId?: string | null;
  issueTitle?: string | null;
  projectId?: string | null;
};

export function parseApprovalContent(content: unknown): ApprovalContent | null {
  const parsed = approvalContentSchema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

export function toApprovalSummary(artifact: any, run?: any): ApprovalSummary | null {
  const content = parseApprovalContent(artifact?.content);
  if (!content) return null;

  const issueId = run?.issue?.id ?? run?.issueId ?? null;
  const issueTitle = run?.issue?.title ?? null;
  const projectId = run?.issue?.projectId ?? run?.projectId ?? null;

  return {
    id: String(artifact?.id ?? ""),
    runId: String(artifact?.runId ?? ""),
    createdAt: String(artifact?.createdAt ?? ""),
    action: content.action,
    status: content.status,
    requestedBy: typeof content.requestedBy === "string" ? content.requestedBy : null,
    requestedAt: typeof content.requestedAt === "string" ? content.requestedAt : null,
    decidedBy: typeof content.decidedBy === "string" ? content.decidedBy : content.decidedBy ?? null,
    decidedAt: typeof content.decidedAt === "string" ? content.decidedAt : content.decidedAt ?? null,
    reason: typeof content.reason === "string" ? content.reason : content.reason ?? null,
    issueId,
    issueTitle,
    projectId,
  };
}

export function findLatestApprovalArtifact(opts: {
  artifacts: any[];
  action: ApprovalAction;
  status?: ApprovalStatus | ApprovalStatus[];
}): { artifact: any; content: ApprovalContent } | null {
  const { artifacts, action } = opts;
  const statuses = Array.isArray(opts.status) ? new Set(opts.status) : opts.status ? new Set([opts.status]) : null;

  const sorted = [...(Array.isArray(artifacts) ? artifacts : [])].sort((a, b) => {
    const ta = Date.parse(String(a?.createdAt ?? "")) || 0;
    const tb = Date.parse(String(b?.createdAt ?? "")) || 0;
    return tb - ta;
  });

  for (const a of sorted) {
    if (a?.type !== "report") continue;
    const content = parseApprovalContent(a?.content);
    if (!content) continue;
    if (content.action !== action) continue;
    if (statuses && !statuses.has(content.status)) continue;
    return { artifact: a, content };
  }
  return null;
}

export async function requestMergePrApproval(opts: {
  prisma: PrismaDeps;
  runId: string;
  requestedBy?: string;
  payload?: { squash?: boolean; mergeCommitMessage?: string };
}): Promise<
  | { success: true; data: { approval: ApprovalSummary } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const run = await opts.prisma.run.findUnique({
    where: { id: opts.runId },
    include: { issue: { include: { project: true } }, artifacts: true },
  });
  if (!run) {
    return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };
  }

  const pr = (run as any)?.artifacts?.find((a: any) => a?.type === "pr") ?? null;
  if (!pr) {
    return { success: false, error: { code: "NO_PR", message: "该 Run 尚未创建 PR" } };
  }

  const existing = findLatestApprovalArtifact({
    artifacts: (run as any)?.artifacts ?? [],
    action: "merge_pr",
    status: ["pending", "approved", "executing"],
  });
  if (existing) {
    const summary = toApprovalSummary(existing.artifact, run);
    if (summary) return { success: true, data: { approval: summary } };
  }

  const now = new Date().toISOString();
  const requestedBy = typeof opts.requestedBy === "string" && opts.requestedBy.trim() ? opts.requestedBy.trim() : "user";
  const payload = opts.payload && typeof opts.payload === "object" ? opts.payload : {};

  const created = await opts.prisma.artifact.create({
    data: {
      id: uuidv7(),
      runId: (run as any).id,
      type: "report",
      content: {
        kind: "approval_request",
        version: 1,
        action: "merge_pr",
        status: "pending",
        requestedBy,
        requestedAt: now,
        payload: {
          prArtifactId: String((pr as any).id ?? ""),
          squash: payload.squash ?? undefined,
          mergeCommitMessage: payload.mergeCommitMessage ?? undefined,
        },
      } as any,
    },
  });

  const prUrl =
    typeof (pr as any)?.content?.webUrl === "string"
      ? String((pr as any).content.webUrl).trim()
      : typeof (pr as any)?.content?.web_url === "string"
        ? String((pr as any).content.web_url).trim()
        : "";

  await opts.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: (run as any).id,
        source: "system",
        type: "approval.merge_pr.requested",
        payload: {
          approvalId: (created as any).id,
          requestedBy,
          requestedAt: now,
          prUrl: prUrl || undefined,
        } as any,
      },
    })
    .catch(() => {});

  const issue: any = (run as any)?.issue;
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
      kind: "merge_pr_requested",
      runId: String((run as any).id),
      approvalId: String((created as any).id),
      prUrl: prUrl || null,
    });
  }

  const summary = toApprovalSummary(created, run);
  if (!summary) {
    return { success: false, error: { code: "BAD_APPROVAL", message: "审批请求写入成功但解析失败" } };
  }
  return { success: true, data: { approval: summary } };
}

export function withApprovalUpdate(prev: ApprovalContent, patch: Partial<ApprovalContent>): ApprovalContent {
  const next = approvalContentSchema.safeParse({ ...prev, ...patch });
  if (next.success) return next.data;
  return { ...prev, ...patch } as ApprovalContent;
}
