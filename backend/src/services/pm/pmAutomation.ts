import type { PrismaDeps } from "../../deps.js";
import { uuidv7 } from "../../utils/uuid.js";
import { startIssueRun, type CreateWorkspaceResult } from "../startIssueRun.js";
import type { AcpTunnel } from "../acpTunnel.js";
import { analyzeIssueForPm } from "./pmAnalyzeIssue.js";
import { isPmAutomationEnabled } from "./pmLlm.js";
import { getPmPolicyFromBranchProtection } from "./pmPolicy.js";

export type PmAutomation = {
  triggerAutoStart: (issueId: string, reason: string) => void;
  analyze: (issueId: string) => ReturnType<typeof analyzeIssueForPm>;
  dispatch: (issueId: string, reason: string) => Promise<unknown>;
};

type IssueQueueTask = () => Promise<void>;

function enqueueByKey(queue: Map<string, Promise<void>>, key: string, task: IssueQueueTask): Promise<void> {
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

export function createPmAutomation(deps: {
  prisma: PrismaDeps;
  acp: AcpTunnel;
  createWorkspace?: (opts: { runId: string; baseBranch: string; name: string }) => Promise<CreateWorkspaceResult>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): PmAutomation {
  const queue = new Map<string, Promise<void>>();
  const log = deps.log ?? (() => {});

  async function dispatchIssue(issueId: string, reason: string) {
    const issue = await deps.prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true, status: true, archivedAt: true, project: { select: { branchProtection: true } } },
    });
    if (!issue) {
      return { success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } };
    }
    if ((issue as any).archivedAt) {
      return { success: true, data: { skipped: true, reason: "ARCHIVED" } };
    }

    const isManual = String(reason ?? "").trim().toLowerCase() === "manual";
    if (!isManual) {
      const branchProtection = (issue as any).project?.branchProtection;
      const { policy } = getPmPolicyFromBranchProtection(branchProtection);
      if (!policy.automation.autoStartIssue) {
        return { success: true, data: { skipped: true, reason: "POLICY_AUTO_START_DISABLED" } };
      }
    }
    if ((issue as any).status !== "pending") {
      return { success: true, data: { skipped: true, reason: "NOT_PENDING" } };
    }

    const analyzed = await analyzeIssueForPm({ prisma: deps.prisma, issueId });
    if (!analyzed.ok) return { success: false, error: analyzed.error };

    const analysis = analyzed.analysis;
    const extraPrompt = [
      "（系统/PM）以下为 PM 自动分析结果（供参考）：",
      `- 风险等级: ${analysis.risk}`,
      analysis.recommendedTrack ? `- 推荐轨道: ${analysis.recommendedTrack}` : "",
      `- 摘要: ${analysis.summary}`,
      analysis.questions.length ? `- 需要确认:\n${analysis.questions.map((q) => `  - ${q}`).join("\n")}` : "",
      `- 触发原因: ${reason}`,
    ]
      .filter(Boolean)
      .join("\n");

    const startRes = await startIssueRun({
      prisma: deps.prisma,
      acp: deps.acp,
      createWorkspace: deps.createWorkspace,
      issueId,
      agentId: analysis.recommendedAgentId ?? undefined,
      roleKey: analysis.recommendedRoleKey ?? undefined,
      extraPromptParts: [extraPrompt],
    });

    if (!startRes.success) {
      log("pm dispatch failed", { issueId, reason, code: startRes.error.code, details: startRes.error.details });
      return startRes;
    }

    const runId = (startRes as any).data?.run?.id;
    if (typeof runId === "string" && runId) {
      await deps.prisma.event
        .create({
          data: {
            id: uuidv7(),
            runId,
            source: "system",
            type: "pm.analysis.generated",
            payload: {
              reason,
              analysis,
              meta: analyzed.meta,
              createdAt: new Date().toISOString(),
            } as any,
          } as any,
        })
        .catch((err: unknown) => log("pm analysis event create failed", { issueId, runId, err: String(err) }));
    }

    return {
      success: true,
      data: {
        run: (startRes as any).data.run,
        analysis,
        meta: analyzed.meta,
      },
    };
  }

  function triggerAutoStart(issueId: string, reason: string) {
    if (!isPmAutomationEnabled()) return;
    void enqueueByKey(queue, issueId, async () => {
      try {
        await dispatchIssue(issueId, reason);
      } catch (err) {
        log("pm auto start crashed", { issueId, reason, err: String(err) });
      }
    });
  }

  return {
    triggerAutoStart,
    analyze: (issueId: string) => analyzeIssueForPm({ prisma: deps.prisma, issueId }),
    dispatch: dispatchIssue,
  };
}
