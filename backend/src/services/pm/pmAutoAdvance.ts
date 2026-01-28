import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps } from "../../deps.js";
import { uuidv7 } from "../../utils/uuid.js";
import { createGitProcessEnv } from "../../utils/gitAuth.js";
import { createReviewRequestForRun } from "../runReviewRequest.js";
import { requestCreatePrApproval, requestMergePrApproval } from "../approvalRequests.js";
import { autoReviewRunForPm } from "./pmAutoReviewRun.js";
import { isPmAutomationEnabled } from "./pmLlm.js";
import { getPmPolicyFromBranchProtection } from "./pmPolicy.js";

const execFileAsync = promisify(execFile);

type AutoAdvanceTrigger = "run_completed" | "ci_completed";
type QueueTask = () => Promise<void>;

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

async function defaultGitPush(opts: { cwd: string; branch: string; project: any }) {
  const { env, cleanup } = await createGitProcessEnv(opts.project);
  try {
    await execFileAsync("git", ["push", "-u", "origin", opts.branch], { cwd: opts.cwd, env });
  } finally {
    await cleanup();
  }
}

function hasScmPr(run: any): boolean {
  if (typeof run?.scmPrUrl === "string" && run.scmPrUrl.trim()) return true;
  const n = Number(run?.scmPrNumber ?? 0);
  return Number.isFinite(n) && n > 0;
}

async function runAutoAdvanceOnce(
  deps: {
    prisma: PrismaDeps;
    gitPush?: (opts: { cwd: string; branch: string; project: any }) => Promise<void>;
    log?: (msg: string, extra?: Record<string, unknown>) => void;
  },
  runId: string,
  trigger: AutoAdvanceTrigger,
): Promise<void> {
  if (!isPmAutomationEnabled()) return;

  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: { issue: { include: { project: true } } } as any,
  });
  if (!run) return;
  if ((run as any).taskId) return;

  const issue: any = (run as any).issue;
  const project: any = issue?.project;
  if (!issue || !project) return;

  const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);
  const allowReview = policy.automation.autoReview !== false;
  const allowCreatePr = policy.automation.autoCreatePr !== false;
  const allowAutoRequestMergeApproval = policy.automation.autoRequestMergeApproval !== false;

  const log = deps.log ?? (() => {});

  if (allowReview) {
    await autoReviewRunForPm({ prisma: deps.prisma }, runId, { commentToGithub: trigger === "ci_completed" }).catch((err: unknown) => {
      log("pm auto-review failed", { runId, trigger, err: String(err) });
    });
  }

  if (trigger === "run_completed" && allowCreatePr) {
    const hasPr = hasScmPr(run as any);
    if (hasPr) return;
    const requireCreatePrApproval =
      policy.approvals.requireForActions.includes("create_pr");

    if (requireCreatePrApproval) {
      const req = await requestCreatePrApproval({
        prisma: deps.prisma,
        runId,
        requestedBy: "pm_auto",
        payload: {
          // backend 不再基于本地 git diff 做敏感目录判断
        },
      }).catch((err: unknown) => ({
        success: false as const,
        error: { code: "APPROVAL_REQUEST_FAILED", message: "创建 PR 审批请求失败", details: String(err) },
      }));

      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId,
            source: "system",
            type: req.success ? "pm.pr.auto_create.approval_requested" : "pm.pr.auto_create.approval_request_failed",
            payload: req.success ? { trigger, approvalId: req.data.approval.id } : { trigger, error: (req as any).error },
          } as any,
        })
        .catch(() => {});

      if (!req.success) log("pm auto request create-pr approval failed", { runId, trigger, error: (req as any).error });
      return;
    }

    const gitPush = deps.gitPush ?? defaultGitPush;
    const res = await createReviewRequestForRun({ prisma: deps.prisma, gitPush }, runId, {}).catch((err: unknown) => ({
      success: false,
      error: { code: "PR_CREATE_FAILED", message: "创建 PR 失败", details: String(err) },
    }));

    if (!res.success) {
      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId,
            source: "system",
            type: "pm.pr.auto_create.failed",
            payload: { trigger, error: res.error } as any,
          },
        })
        .catch(() => {});
      log("pm auto create-pr failed", { runId, trigger, error: res.error });
      return;
    }

    await deps.prisma.event
      .create({
        data: {
          id: uuidv7(),
          runId,
          source: "system",
          type: "pm.pr.auto_created",
          payload: { trigger } as any,
        },
      })
      .catch(() => {});
    return;
  }

  if (trigger === "ci_completed" && allowAutoRequestMergeApproval) {
    const passed = String((run as any).scmCiStatus ?? "") === "passed";
    if (!passed) return;

    if (!policy.approvals.requireForActions.includes("merge_pr")) return;

    const hasPr = hasScmPr(run as any);
    if (!hasPr) return;

    await requestMergePrApproval({
      prisma: deps.prisma,
      runId,
      requestedBy: "pm_auto",
    }).catch((err: unknown) => log("pm auto request merge approval failed", { runId, trigger, err: String(err) }));
  }
}

const issueQueue = new Map<string, Promise<void>>();

export function triggerPmAutoAdvance(deps: { prisma: PrismaDeps; log?: (msg: string, extra?: Record<string, unknown>) => void }, opts: {
  runId: string;
  issueId: string;
  trigger: AutoAdvanceTrigger;
}) {
  if (!isPmAutomationEnabled()) return;
  const runId = String(opts.runId ?? "").trim();
  const issueId = String(opts.issueId ?? "").trim();
  if (!runId || !issueId) return;

  void enqueueByKey(issueQueue, issueId, async () => {
    try {
      await runAutoAdvanceOnce(deps, runId, opts.trigger);
    } catch (err) {
      deps.log?.("pm auto advance crashed", { runId, issueId, trigger: opts.trigger, err: String(err) });
    }
  });
}
