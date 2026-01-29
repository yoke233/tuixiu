import { useState } from "react";
import { Link } from "react-router-dom";

import { StatusBadge } from "../../../components/StatusBadge";
import { ThemeToggle } from "../../../components/ThemeToggle";
import type { SessionController } from "../useSessionController";

export function SessionSidebar(props: { model: SessionController }) {
  const {
    issue,
    loading,
    refreshing,
    refresh,
    run,
    runId,
    sessionId,
    sessionState,
    ws,
    settingMode,
    settingModel,
    onSetMode,
    onSetModel,
  } = props.model;

  const [modeDraft, setModeDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");

  return (
    <aside className="sessionSide">
      <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Session 控制台</div>
          <div className="muted">
            WS: {ws.status}
            {refreshing ? " · 同步中…" : ""}
          </div>
        </div>
        <ThemeToggle />
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
        <section className="card">
          <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
            <div style={{ fontWeight: 800 }}>导航</div>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => void refresh()}
              disabled={refreshing || !runId}
            >
              刷新
            </button>
          </div>
          <div className="row gap" style={{ marginTop: 10 }}>
            <Link className="buttonSecondary" to="/issues">
              ← 看板
            </Link>
            {issue?.id ? (
              <Link className="buttonSecondary" to={`/issues/${issue.id}`}>
                Issue 详情
              </Link>
            ) : null}
            <Link className="buttonSecondary" to="/admin?section=acpSessions">
              Sessions 列表
            </Link>
          </div>
        </section>

        <section className="card">
          <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
            <div style={{ fontWeight: 800 }}>当前 Run</div>
            {run ? <StatusBadge status={run.status} /> : null}
          </div>
          {loading ? (
            <div className="muted" style={{ marginTop: 10 }}>
              加载中…
            </div>
          ) : run ? (
            <div className="kvGrid" style={{ marginTop: 12 }}>
              <div className="kvItem">
                <div className="muted">runId</div>
                <code title={run.id}>{run.id}</code>
              </div>
              <div className="kvItem">
                <div className="muted">issueId</div>
                <code title={run.issueId}>{run.issueId}</code>
              </div>
              <div className="kvItem">
                <div className="muted">sessionId</div>
                {sessionId ? <code title={sessionId}>{sessionId}</code> : <span className="muted">未建立</span>}
              </div>
              <div className="kvItem">
                <div className="muted">branch</div>
                {run.branchName ? <code title={run.branchName}>{run.branchName}</code> : <span className="muted">-</span>}
              </div>
              <div className="kvItem">
                <div className="muted">workspace</div>
                {run.workspacePath ? (
                  <code title={run.workspacePath}>{run.workspacePath}</code>
                ) : (
                  <span className="muted">-</span>
                )}
              </div>
              <div className="kvItem">
                <div className="muted">agentId</div>
                {run.agentId ? <code title={run.agentId}>{run.agentId}</code> : <span className="muted">-</span>}
              </div>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              Run 不存在或无权限
            </div>
          )}
        </section>

        <section className="card">
          <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
            <div style={{ fontWeight: 800 }}>Session 状态</div>
            {sessionState ? <StatusBadge status={sessionState.activity as any} /> : <span className="muted">-</span>}
          </div>
          {sessionState ? (
            <>
              <div className="muted" style={{ marginTop: 10 }}>
                {sessionState.inFlight ? `inFlight=${sessionState.inFlight} · ` : ""}
                {sessionState.currentModeId ? `mode=${sessionState.currentModeId} · ` : ""}
                {sessionState.currentModelId ? `model=${sessionState.currentModelId} · ` : ""}
                {sessionState.lastStopReason ? `stop=${sessionState.lastStopReason} · ` : ""}
                {sessionState.updatedAt ? new Date(sessionState.updatedAt).toLocaleString() : ""}
                {sessionState.note ? ` · ${sessionState.note}` : ""}
              </div>

              {sessionId ? (
                <details style={{ marginTop: 12 }}>
                  <summary>设置 mode / model</summary>
                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    <div className="row gap" style={{ alignItems: "flex-end" }}>
                      <label className="label" style={{ margin: 0, flex: "1 1 220px", minWidth: 200 }}>
                        modeId
                        <input
                          value={modeDraft}
                          onChange={(e) => setModeDraft(e.target.value)}
                          placeholder={sessionState.currentModeId ? `当前：${sessionState.currentModeId}` : "例如：balanced"}
                        />
                      </label>
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => setModeDraft(sessionState.currentModeId ?? "")}
                        disabled={settingMode || settingModel}
                        title="把当前 mode 填入输入框"
                      >
                        填入当前
                      </button>
                      <button
                        type="button"
                        onClick={() => void onSetMode(modeDraft)}
                        disabled={!modeDraft.trim() || settingMode || settingModel}
                      >
                        {settingMode ? "设置中…" : "设置 mode"}
                      </button>
                    </div>

                    <div className="row gap" style={{ alignItems: "flex-end" }}>
                      <label className="label" style={{ margin: 0, flex: "1 1 220px", minWidth: 200 }}>
                        modelId
                        <input
                          value={modelDraft}
                          onChange={(e) => setModelDraft(e.target.value)}
                          placeholder={sessionState.currentModelId ? `当前：${sessionState.currentModelId}` : "例如：gpt-4.1"}
                        />
                      </label>
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => setModelDraft(sessionState.currentModelId ?? "")}
                        disabled={settingMode || settingModel}
                        title="把当前 model 填入输入框"
                      >
                        填入当前
                      </button>
                      <button
                        type="button"
                        onClick={() => void onSetModel(modelDraft)}
                        disabled={!modelDraft.trim() || settingMode || settingModel}
                      >
                        {settingModel ? "设置中…" : "设置 model"}
                      </button>
                    </div>

                    <div className="muted">
                      后端接口：<code>POST /api/admin/acp-sessions/set-mode</code>、<code>POST /api/admin/acp-sessions/set-model</code>。
                    </div>
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              暂无 session_state（等待 Agent 上报）
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
