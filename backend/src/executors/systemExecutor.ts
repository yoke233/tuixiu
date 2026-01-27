import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PrismaDeps } from "../deps.js";
import { createGitProcessEnv } from "../utils/gitAuth.js";
import { createReviewRequestForRun } from "../services/runReviewRequest.js";
import { advanceTaskFromRunTerminal } from "../services/taskProgress.js";
import { planArtifactPublish, publishArtifact } from "../services/artifactPublish.js";
import { requestCreatePrApproval, requestPublishArtifactApproval } from "../services/approvalRequests.js";
import { getPmPolicyFromBranchProtection } from "../services/pm/pmPolicy.js";
import { computeSensitiveHitFromFiles, computeSensitiveHitFromPaths } from "../services/pm/pmSensitivePaths.js";
import { getRunChanges } from "../services/runGitChanges.js";

const execFileAsync = promisify(execFile);

async function defaultGitPush(opts: { cwd: string; branch: string; project: any }) {
  const { env, cleanup } = await createGitProcessEnv(opts.project);
  try {
    await execFileAsync("git", ["push", "-u", "origin", opts.branch], { cwd: opts.cwd, env });
  } finally {
    await cleanup();
  }
}

export async function startSystemExecution(deps: { prisma: PrismaDeps }, runId: string): Promise<{ executed: boolean }> {
  const run = await deps.prisma.run.findUnique({
    where: { id: runId },
    include: {
      step: true,
      task: { include: { issue: { include: { project: true } } } },
      artifacts: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!run) throw new Error("Run 不存在");

  const step = (run as any).step as any;
  const task = (run as any).task as any;
  const issue = task?.issue as any;
  const project = issue?.project as any;
  if (!step || !task || !issue || !project) throw new Error("Run 缺少 step/task/issue/project");

  const kind = String(step.kind ?? "").trim();
  const { policy } = getPmPolicyFromBranchProtection(project.branchProtection);

  if (kind === "pr.create") {
    const sensitivePatterns = Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [];
    const needSensitiveCheck =
      sensitivePatterns.length > 0 && policy.approvals.escalateOnSensitivePaths.includes("create_pr");

    let sensitive = null as ReturnType<typeof computeSensitiveHitFromFiles> | null;
    let sensitiveCheckFailed = false;
    if (needSensitiveCheck) {
      try {
        const changes = await getRunChanges({ prisma: deps.prisma, runId });
        sensitive = computeSensitiveHitFromFiles(changes.files ?? [], sensitivePatterns);
      } catch {
        sensitiveCheckFailed = true;
      }
    }

    const requireApproval =
      policy.approvals.requireForActions.includes("create_pr") ||
      (needSensitiveCheck && (sensitive !== null || sensitiveCheckFailed));

    if (requireApproval) {
      await requestCreatePrApproval({
        prisma: deps.prisma,
        runId,
        requestedBy: "system_step",
        payload: {
          sensitive: sensitive
            ? { patterns: sensitive.patterns.slice(0, 20), matchedFiles: sensitive.matchedFiles.slice(0, 60) }
            : undefined,
        },
      });

      await deps.prisma.step.update({ where: { id: step.id }, data: { status: "waiting_human" } as any }).catch(() => {});
      await deps.prisma.issue.update({ where: { id: issue.id }, data: { status: "reviewing" } as any }).catch(() => {});
      return { executed: false };
    }

    const res = await createReviewRequestForRun(
      {
        prisma: deps.prisma,
        gitPush: defaultGitPush,
      },
      runId,
      {},
      { setRunWaitingCi: false },
    );
    if (!res.success) {
      throw new Error(`${res.error?.code ?? "PR_CREATE_FAILED"}: ${res.error?.message ?? "创建 PR 失败"}`);
    }

    await deps.prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() } as any,
    });
    await advanceTaskFromRunTerminal({ prisma: deps.prisma }, runId, "completed");
    return { executed: true };
  }

  if (kind === "report.publish") {
    const desired = typeof (step.params as any)?.kind === "string" ? String((step.params as any).kind).trim() : "";
    const desiredType = desired === "test" ? "ci_result" : "report";

    const candidates = await deps.prisma.artifact.findMany({
      where: { type: desiredType, run: { is: { taskId: task.id } } } as any,
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    const picked =
      desired && desiredType === "report"
        ? (candidates as any[]).find((a) => String((a.content as any)?.kind ?? "") === desired) ?? candidates[0]
        : candidates[0];

    if (!picked) {
      throw new Error("没有可发布的产物（report/ci_result）");
    }

    const sensitivePatterns = Array.isArray(policy.sensitivePaths) ? policy.sensitivePaths : [];
    const needSensitiveCheck =
      sensitivePatterns.length > 0 && policy.approvals.escalateOnSensitivePaths.includes("publish_artifact");

    const plan = await planArtifactPublish({ prisma: deps.prisma }, String((picked as any).id));
    if (!plan.success) {
      throw new Error(`${plan.error?.code ?? "PUBLISH_PLAN_FAILED"}: ${plan.error?.message ?? "发布预检查失败"}`);
    }

    const sensitive = needSensitiveCheck ? computeSensitiveHitFromPaths([plan.data.path], sensitivePatterns) : null;
    const requireApproval =
      policy.approvals.requireForActions.includes("publish_artifact") ||
      (needSensitiveCheck && sensitive !== null);

    if (requireApproval) {
      await requestPublishArtifactApproval({
        prisma: deps.prisma,
        artifactId: String((picked as any).id),
        requestedBy: "system_step",
        payload: {
          path: plan.data.path,
          sensitive: sensitive
            ? { patterns: sensitive.patterns.slice(0, 20), matchedFiles: sensitive.matchedFiles.slice(0, 60) }
            : undefined,
        },
      });

      await deps.prisma.step.update({ where: { id: step.id }, data: { status: "waiting_human" } as any }).catch(() => {});
      await deps.prisma.issue.update({ where: { id: issue.id }, data: { status: "reviewing" } as any }).catch(() => {});
      return { executed: false };
    }

    const res = await publishArtifact({ prisma: deps.prisma }, (picked as any).id);
    if (!res.success) {
      throw new Error(`${res.error?.code ?? "PUBLISH_FAILED"}: ${res.error?.message ?? "发布失败"}`);
    }

    await deps.prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() } as any,
    });
    await advanceTaskFromRunTerminal({ prisma: deps.prisma }, runId, "completed");
    return { executed: true };
  }

  throw new Error(`不支持的 system step: ${kind || "unknown"}`);
}
