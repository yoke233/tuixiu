import { z } from "zod";

import type { PrismaDeps } from "../deps.js";
import { uuidv7 } from "../utils/uuid.js";
import { postGitHubApprovalCommentBestEffort } from "./githubIssueComments.js";

const approvalActionSchema = z.enum(["merge_pr", "create_pr", "publish_artifact"]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "executing", "executed", "failed"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

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

function toIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  return s ? s : null;
}

function isAllowedAction(value: unknown): value is ApprovalAction {
  return approvalActionSchema.safeParse(value).success;
}

function isAllowedStatus(value: unknown): value is ApprovalStatus {
  return approvalStatusSchema.safeParse(value).success;
}

export function toApprovalSummary(approval: any, run?: any): ApprovalSummary | null {
  if (!approval) return null;
  if (!isAllowedAction(approval.action)) return null;
  if (!isAllowedStatus(approval.status)) return null;

  const issueId = run?.issue?.id ?? run?.issueId ?? null;
  const issueTitle = run?.issue?.title ?? null;
  const projectId = run?.issue?.projectId ?? run?.projectId ?? null;

  return {
    id: String(approval.id ?? ""),
    runId: String(approval.runId ?? ""),
    createdAt: toIso(approval.createdAt) ?? "",
    action: approval.action,
    status: approval.status,
    requestedBy: typeof approval.requestedBy === "string" ? approval.requestedBy : null,
    requestedAt: toIso(approval.requestedAt),
    decidedBy: typeof approval.decidedBy === "string" ? approval.decidedBy : null,
    decidedAt: toIso(approval.decidedAt),
    reason: typeof approval.reason === "string" ? approval.reason : null,
    issueId,
    issueTitle,
    projectId,
  };
}

async function findLatestApproval(
  prisma: PrismaDeps,
  opts: { runId: string; action: ApprovalAction; status?: ApprovalStatus | ApprovalStatus[] },
): Promise<any | null> {
  const statuses = Array.isArray(opts.status) ? opts.status : opts.status ? [opts.status] : null;
  return await prisma.approval
    .findFirst({
      where: {
        runId: opts.runId,
        action: opts.action as any,
        ...(statuses ? { status: { in: statuses as any } } : null),
      } as any,
      orderBy: { createdAt: "desc" } as any,
    })
    .catch(() => null);
}

function extractPrHint(run: any): { prNumber: number | null; prUrl: string | null } {
  const prNumber = Number.isFinite(run?.scmPrNumber as any) ? Number(run.scmPrNumber) : null;
  const prUrl = typeof run?.scmPrUrl === "string" ? String(run.scmPrUrl).trim() : "";
  if ((prNumber && prNumber > 0) || prUrl) return { prNumber: prNumber && prNumber > 0 ? prNumber : null, prUrl: prUrl || null };

  const prArtifact = (run?.artifacts ?? []).find((a: any) => a?.type === "pr");
  const content = (prArtifact?.content ?? {}) as any;
  const fallbackNumber = Number(content.iid ?? content.number);
  const fallbackUrl =
    typeof content.webUrl === "string"
      ? String(content.webUrl).trim()
      : typeof content.web_url === "string"
        ? String(content.web_url).trim()
        : "";
  return {
    prNumber: Number.isFinite(fallbackNumber) && fallbackNumber > 0 ? fallbackNumber : null,
    prUrl: fallbackUrl || null,
  };
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
  if (!run) return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };

  const { prUrl } = extractPrHint(run as any);
  if (!prUrl) return { success: false, error: { code: "NO_PR", message: "该 Run 尚未创建 PR" } };

  const existing = await findLatestApproval(opts.prisma, {
    runId: (run as any).id,
    action: "merge_pr",
    status: ["pending", "approved", "executing"],
  });
  if (existing) {
    const summary = toApprovalSummary(existing, run);
    if (summary) return { success: true, data: { approval: summary } };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const requestedBy = typeof opts.requestedBy === "string" && opts.requestedBy.trim() ? opts.requestedBy.trim() : "user";
  const payload = opts.payload && typeof opts.payload === "object" ? opts.payload : {};

  const created = await opts.prisma.approval.create({
    data: {
      id: uuidv7(),
      runId: (run as any).id,
      action: "merge_pr" as any,
      status: "pending" as any,
      requestedBy,
      requestedAt: now,
      payload: {
        squash: payload.squash ?? undefined,
        mergeCommitMessage: payload.mergeCommitMessage ?? undefined,
      } as any,
    } as any,
  });

  await opts.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: (run as any).id,
        source: "system",
        type: "approval.merge_pr.requested",
        payload: { approvalId: (created as any).id, requestedBy, requestedAt: nowIso, prUrl } as any,
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
      prUrl,
    });
  }

  const summary = toApprovalSummary(created, run);
  if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批请求写入成功但解析失败" } };
  return { success: true, data: { approval: summary } };
}

export async function requestCreatePrApproval(opts: {
  prisma: PrismaDeps;
  runId: string;
  requestedBy?: string;
  payload?: { title?: string; description?: string; targetBranch?: string; sensitive?: unknown };
}): Promise<
  | { success: true; data: { approval: ApprovalSummary } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const run = await opts.prisma.run.findUnique({
    where: { id: opts.runId },
    include: { issue: { include: { project: true } } },
  });
  if (!run) return { success: false, error: { code: "NOT_FOUND", message: "Run 不存在" } };

  const existing = await findLatestApproval(opts.prisma, {
    runId: (run as any).id,
    action: "create_pr",
    status: ["pending", "approved", "executing"],
  });
  if (existing) {
    const summary = toApprovalSummary(existing, run);
    if (summary) return { success: true, data: { approval: summary } };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const requestedBy = typeof opts.requestedBy === "string" && opts.requestedBy.trim() ? opts.requestedBy.trim() : "user";
  const payload = opts.payload && typeof opts.payload === "object" ? opts.payload : {};

  const created = await opts.prisma.approval.create({
    data: {
      id: uuidv7(),
      runId: (run as any).id,
      action: "create_pr" as any,
      status: "pending" as any,
      requestedBy,
      requestedAt: now,
      payload: {
        title: typeof payload.title === "string" ? payload.title : undefined,
        description: typeof payload.description === "string" ? payload.description : undefined,
        targetBranch: typeof payload.targetBranch === "string" ? payload.targetBranch : undefined,
        sensitive: payload.sensitive ?? undefined,
      } as any,
    } as any,
  });

  await opts.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: (run as any).id,
        source: "system",
        type: "approval.create_pr.requested",
        payload: { approvalId: (created as any).id, requestedBy, requestedAt: nowIso } as any,
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
      kind: "create_pr_requested",
      runId: String((run as any).id),
      approvalId: String((created as any).id),
    });
  }

  const summary = toApprovalSummary(created, run);
  if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批请求写入成功但解析失败" } };
  return { success: true, data: { approval: summary } };
}

export async function requestPublishArtifactApproval(opts: {
  prisma: PrismaDeps;
  artifactId: string;
  requestedBy?: string;
  payload?: { path?: string; sensitive?: { patterns: string[]; matchedFiles: string[] } };
}): Promise<
  | { success: true; data: { approval: ApprovalSummary } }
  | { success: false; error: { code: string; message: string; details?: string } }
> {
  const artifact = await opts.prisma.artifact.findUnique({
    where: { id: opts.artifactId },
    include: { run: { include: { issue: { include: { project: true } }, approvals: true } } } as any,
  });
  if (!artifact) return { success: false, error: { code: "NOT_FOUND", message: "Artifact 不存在" } };

  const run = (artifact as any)?.run;
  if (!run) return { success: false, error: { code: "NO_RUN", message: "Artifact 未绑定 Run" } };

  const existing = await findLatestApproval(opts.prisma, {
    runId: String((run as any).id),
    action: "publish_artifact",
    status: ["pending", "approved", "executing"],
  });
  if (existing) {
    const summary = toApprovalSummary(existing, run);
    if (summary) return { success: true, data: { approval: summary } };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const requestedBy = typeof opts.requestedBy === "string" && opts.requestedBy.trim() ? opts.requestedBy.trim() : "user";
  const payload = opts.payload && typeof opts.payload === "object" ? opts.payload : {};

  const created = await opts.prisma.approval.create({
    data: {
      id: uuidv7(),
      runId: String((run as any).id),
      action: "publish_artifact" as any,
      status: "pending" as any,
      requestedBy,
      requestedAt: now,
      payload: {
        sourceArtifactId: String((artifact as any).id),
        path: typeof payload.path === "string" ? payload.path : undefined,
        sensitive: payload.sensitive && typeof payload.sensitive === "object" ? payload.sensitive : undefined,
      } as any,
    } as any,
  });

  await opts.prisma.event
    .create({
      data: {
        id: uuidv7(),
        runId: String((run as any).id),
        source: "system",
        type: "approval.publish_artifact.requested",
        payload: { approvalId: (created as any).id, requestedBy, requestedAt: nowIso, artifactId: String((artifact as any).id) } as any,
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
      kind: "publish_artifact_requested",
      runId: String((run as any).id),
      approvalId: String((created as any).id),
    });
  }

  const summary = toApprovalSummary(created, run);
  if (!summary) return { success: false, error: { code: "BAD_APPROVAL", message: "审批请求写入成功但解析失败" } };
  return { success: true, data: { approval: summary } };
}

