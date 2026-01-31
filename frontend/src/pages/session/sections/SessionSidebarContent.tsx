import { useState } from "react";
import { Link } from "react-router-dom";

import { StatusBadge } from "../../../components/StatusBadge";
import type { SessionController } from "../useSessionController";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SessionSidebarContentProps = {
  model: SessionController;
  showBackLink?: boolean;
  onNavigate?: () => void;
};

export function SessionSidebarContent(props: SessionSidebarContentProps) {
  const { model, showBackLink = true, onNavigate } = props;
  const {
    issue,
    loading,
    refreshing,
    refresh,
    run,
    runId,
    sessionId,
    sessionState,
    settingMode,
    settingModel,
    permissionRequests,
    resolvingPermissionId,
    isAdmin,
    onSetMode,
    onSetModel,
    onResolvePermission,
  } = model;

  const [modeDraft, setModeDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");

  const handleNavigate = () => {
    if (onNavigate) onNavigate();
  };

  return (
    <div className="sessionSidebarContent" style={{ marginTop: 12, display: "grid", gap: 12 }}>
      <section className="card">
        <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
          <div style={{ fontWeight: 800 }}>导航</div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing || !runId}
          >
            刷新
          </Button>
        </div>
        <div className="row gap" style={{ marginTop: 10 }}>
          {showBackLink ? (
            <Button asChild variant="secondary" size="sm">
              <Link to="/issues" onClick={handleNavigate}>
                ← 看板
              </Link>
            </Button>
          ) : null}
          {issue?.id ? (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/issues/${issue.id}`} onClick={handleNavigate}>
                Issue 详情
              </Link>
            </Button>
          ) : null}
          <Button asChild variant="secondary" size="sm">
            <Link to="/admin?section=acpSessions" onClick={handleNavigate}>
              ACP Proxies
            </Link>
          </Button>
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
              {sessionId ? (
                <code title={sessionId}>{sessionId}</code>
              ) : (
                <span className="muted">未建立</span>
              )}
            </div>
            <div className="kvItem">
              <div className="muted">branch</div>
              {run.branchName ? (
                <code title={run.branchName}>{run.branchName}</code>
              ) : (
                <span className="muted">-</span>
              )}
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
              {run.agentId ? (
                <code title={run.agentId}>{run.agentId}</code>
              ) : (
                <span className="muted">-</span>
              )}
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
          {sessionState ? (
            <StatusBadge status={sessionState.activity as any} />
          ) : (
            <span className="muted">-</span>
          )}
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
                    <label
                      className="label"
                      style={{ margin: 0, flex: "1 1 220px", minWidth: 200 }}
                    >
                      modeId
                      <Input
                        value={modeDraft}
                        onChange={(e) => setModeDraft(e.target.value)}
                        placeholder={
                          sessionState.currentModeId
                            ? `当前：${sessionState.currentModeId}`
                            : "例如：balanced"
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setModeDraft(sessionState.currentModeId ?? "")}
                      disabled={settingMode || settingModel}
                      title="把当前 mode 填入输入框"
                    >
                      填入当前
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void onSetMode(modeDraft)}
                      disabled={!modeDraft.trim() || settingMode || settingModel}
                      size="sm"
                    >
                      {settingMode ? "设置中…" : "设置 mode"}
                    </Button>
                  </div>

                  <div className="row gap" style={{ alignItems: "flex-end" }}>
                    <label
                      className="label"
                      style={{ margin: 0, flex: "1 1 220px", minWidth: 200 }}
                    >
                      modelId
                      <Input
                        value={modelDraft}
                        onChange={(e) => setModelDraft(e.target.value)}
                        placeholder={
                          sessionState.currentModelId
                            ? `当前：${sessionState.currentModelId}`
                            : "例如：gpt-4.1"
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setModelDraft(sessionState.currentModelId ?? "")}
                      disabled={settingMode || settingModel}
                      title="把当前 model 填入输入框"
                    >
                      填入当前
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void onSetModel(modelDraft)}
                      disabled={!modelDraft.trim() || settingMode || settingModel}
                      size="sm"
                    >
                      {settingModel ? "设置中…" : "设置 model"}
                    </Button>
                  </div>

                  <div className="muted">
                    后端接口：<code>POST /api/admin/acp-sessions/set-mode</code>、
                    <code>POST /api/admin/acp-sessions/set-model</code>。
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

      {permissionRequests.length ? (
        <section className="card">
          <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
            <div style={{ fontWeight: 800 }}>权限请求</div>
            <span className="muted">{permissionRequests.length} 条</span>
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {permissionRequests.map((req) => {
              const allowOption =
                req.options.find((o) => (o.kind ?? "").startsWith("allow")) ?? req.options[0];
              const rejectOption =
                req.options.find((o) => (o.kind ?? "").startsWith("reject")) ?? null;
              const busy = resolvingPermissionId === req.requestId;
              const toolCall = req.toolCall as any;
              const title =
                typeof toolCall?.title === "string" && toolCall.title.trim()
                  ? toolCall.title.trim()
                  : "工具调用权限";
              const kind =
                typeof toolCall?.kind === "string" && toolCall.kind.trim()
                  ? toolCall.kind.trim()
                  : null;

              return (
                <div key={req.requestId} style={{ display: "grid", gap: 8 }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{title}</div>
                    <div className="muted" style={{ marginTop: 4 }}>
                      {kind ? `kind=${kind} · ` : ""}
                      requestId={req.requestId}
                      {req.promptId ? ` · prompt=${req.promptId}` : ""}
                    </div>
                    {req.createdAt ? (
                      <div className="muted" style={{ marginTop: 4 }}>
                        {new Date(req.createdAt).toLocaleString()}
                      </div>
                    ) : null}
                  </div>

                  <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <Button
                      type="button"
                      onClick={() =>
                        allowOption
                          ? onResolvePermission(req, {
                              outcome: "selected",
                              optionId: allowOption.optionId,
                            })
                          : onResolvePermission(req, { outcome: "cancelled" })
                      }
                      disabled={!isAdmin || busy || !allowOption}
                      title={!isAdmin ? "需要管理员权限" : ""}
                      size="sm"
                    >
                      {busy ? "处理中…" : "同意"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        rejectOption
                          ? onResolvePermission(req, {
                              outcome: "selected",
                              optionId: rejectOption.optionId,
                            })
                          : onResolvePermission(req, { outcome: "cancelled" })
                      }
                      disabled={!isAdmin || busy}
                      title={!isAdmin ? "需要管理员权限" : ""}
                      size="sm"
                    >
                      {rejectOption ? "拒绝" : "取消"}
                    </Button>
                    {!isAdmin ? (
                      <span className="muted">仅管理员可审批</span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
