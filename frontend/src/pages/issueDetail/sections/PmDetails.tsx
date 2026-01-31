import { Link } from "react-router-dom";

import type { PmRisk } from "../../../types";
import type { IssueDetailController } from "../useIssueDetailController";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function PmDetails(props: { model: IssueDetailController }) {
  const {
    allowPmTools,
    canPmDispatch,
    currentRunId,
    effectivePmAnalysis,
    effectivePmMeta,
    getPmRiskBadge,
    issueId,
    nextAction,
    nextActionError,
    nextActionLoading,
    onPmAnalyze,
    onPmApplyRecommendation,
    onPmDispatch,
    pmDispatching,
    pmError,
    pmFromArtifact,
    pmLoading,
    pmOpen,
    recommendedAgentName,
    recommendedRoleLabel,
    refreshNextAction,
    setPmOpen,
  } = props.model;

  function renderPmRisk(risk: PmRisk) {
    const { color, label } = getPmRiskBadge(risk);
    if (color === "green")
      return <Badge className="bg-success text-success-foreground hover:bg-success/80">{label}</Badge>;
    if (color === "orange")
      return <Badge className="bg-warning text-warning-foreground hover:bg-warning/80">{label}</Badge>;
    if (color === "red") return <Badge variant="destructive">{label}</Badge>;
    return <Badge variant="secondary">{label}</Badge>;
  }

  return (
    <details
      className="card"
      open={pmOpen}
      onToggle={(e) => {
        setPmOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary className="detailsSummary">
        <div className="row spaceBetween" style={{ alignItems: "center" }}>
          <span className="toolSummaryTitle">PM</span>
          <span className="muted">{effectivePmAnalysis ? `风险：${effectivePmAnalysis.risk}` : "未分析"}</span>
        </div>
      </summary>
      <div className="row spaceBetween" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h2 className="srOnly">PM</h2>
          <div className="muted">分析/推荐（可分配并启动）</div>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button
            type="button"
            size="sm"
            onClick={onPmAnalyze}
            disabled={pmLoading || !issueId || !allowPmTools}
            title={!allowPmTools ? "需要 PM 或管理员权限" : undefined}
          >
            {pmLoading ? "分析中…" : "分析"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onPmDispatch}
            disabled={!allowPmTools || !canPmDispatch || pmDispatching}
            title={!allowPmTools ? "需要 PM 或管理员权限" : undefined}
          >
            {pmDispatching ? "启动中…" : "PM 分配并启动"}
          </Button>
        </div>
      </div>

      {pmError ? (
        <div role="alert" className="alert" style={{ marginTop: 10 }}>
          {pmError}
        </div>
      ) : null}

      <div className="row spaceBetween" style={{ marginTop: 10, alignItems: "center" }}>
        <div>
          <div className="muted">下一步建议</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {nextAction?.source ? `来源：${nextAction.source}` : "（打开后自动加载，可手动刷新）"}
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void refreshNextAction()}
          disabled={!issueId || nextActionLoading}
        >
          {nextActionLoading ? "刷新中…" : "刷新建议"}
        </Button>
      </div>

      {nextActionError ? (
        <div role="alert" className="alert" style={{ marginTop: 10 }}>
          {nextActionError}
        </div>
      ) : null}

      {nextAction ? (
        <div style={{ marginTop: 8 }}>
          <pre className="pre" style={{ whiteSpace: "pre-wrap" }}>{`动作：${nextAction.action}\n原因：${nextAction.reason}`}</pre>
          {nextAction.approval ? (
            <div className="muted" style={{ marginTop: 6 }}>
              待审批：<code>{nextAction.approval.action}</code> · <code>{nextAction.approval.id}</code>{" "}
              <Button variant="link" size="sm" className="h-auto px-0" asChild>
                <Link to="/admin">前往审批队列</Link>
              </Button>
            </div>
          ) : null}
          {nextAction.step ? (
            <div className="muted" style={{ marginTop: 6 }}>
              当前 Step：<code>{nextAction.step.kind}</code> · <code>{nextAction.step.status}</code> ·{" "}
              <code>{nextAction.step.executorType}</code>
            </div>
          ) : null}
          {nextAction.run ? (
            <div className="muted" style={{ marginTop: 6 }}>
              关联 Run：<code>{nextAction.run.id}</code> · <code>{nextAction.run.status}</code>
            </div>
          ) : null}
        </div>
      ) : nextActionLoading ? (
        <div className="muted" style={{ marginTop: 8 }}>
          加载中…
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 8 }}>
          暂无建议
        </div>
      )}

      {effectivePmAnalysis ? (
        <>
          <div className="kvGrid">
            <div className="kvItem">
              <div className="muted">风险</div>
              {renderPmRisk(effectivePmAnalysis.risk)}
            </div>
            <div className="kvItem">
              <div className="muted">来源</div>
              <span className="muted">
                {effectivePmMeta?.source ?? "unknown"}
                {effectivePmMeta?.model ? ` · ${effectivePmMeta.model}` : ""}
              </span>
            </div>
            <div className="kvItem">
              <div className="muted">推荐 Role</div>
              {recommendedRoleLabel ? <code title={recommendedRoleLabel}>{recommendedRoleLabel}</code> : <span className="muted">无</span>}
            </div>
            <div className="kvItem">
              <div className="muted">推荐 Agent</div>
              {recommendedAgentName ? <code title={recommendedAgentName}>{recommendedAgentName}</code> : <span className="muted">自动/无</span>}
            </div>
            <div className="kvItem">
              <div className="muted">推荐 Track</div>
              {effectivePmAnalysis?.recommendedTrack ? (
                <code title={effectivePmAnalysis.recommendedTrack}>{effectivePmAnalysis.recommendedTrack}</code>
              ) : (
                <span className="muted">无</span>
              )}
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <div className="muted">摘要</div>
            <pre className="pre" style={{ whiteSpace: "pre-wrap" }}>
              {effectivePmAnalysis.summary}
            </pre>
          </div>

          {effectivePmAnalysis.questions?.length ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted">需要你确认</div>
              <pre className="pre" style={{ whiteSpace: "pre-wrap" }}>
                {effectivePmAnalysis.questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n")}
              </pre>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              无需额外澄清问题
            </div>
          )}

          {!currentRunId && (effectivePmAnalysis.recommendedRoleKey || effectivePmAnalysis.recommendedAgentId) ? (
            <div className="row gap" style={{ marginTop: 10 }}>
              <Button type="button" size="sm" onClick={onPmApplyRecommendation} disabled={!allowPmTools || pmLoading || pmDispatching}>
                应用推荐到下方手动选择
              </Button>
              {pmFromArtifact?.createdAt ? (
                <span className="muted">最近一次分析：{new Date(pmFromArtifact.createdAt).toLocaleString()}</span>
              ) : null}
            </div>
          ) : pmFromArtifact?.createdAt ? (
            <div className="muted" style={{ marginTop: 10 }}>
              最近一次分析：{new Date(pmFromArtifact.createdAt).toLocaleString()}
              {pmFromArtifact.reason ? ` · ${pmFromArtifact.reason}` : ""}
            </div>
          ) : null}
        </>
      ) : (
        <div className="muted" style={{ marginTop: 8 }}>
          还没有 PM 分析结果：可点击“分析”，或等待自动化在后台生成。
        </div>
      )}
    </details>
  );
}
