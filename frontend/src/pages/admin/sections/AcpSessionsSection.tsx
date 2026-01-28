import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { cancelAcpSession, listAcpSessions, startAcpSession } from "../../../api/acpSessions";
import { StatusBadge } from "../../../components/StatusBadge";
import type { AcpSessionSummary } from "../../../types";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  reloadToken: number;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function AcpSessionsSection(props: Props) {
  const { active, effectiveProjectId, reloadToken, requireAdmin, setError, onLoadingChange } = props;
  const navigate = useNavigate();

  const [acpSessions, setAcpSessions] = useState<AcpSessionSummary[]>([]);
  const [loadingAcpSessions, setLoadingAcpSessions] = useState(false);
  const [cancelingAcpSessionKey, setCancelingAcpSessionKey] = useState<string>("");
  const [startingAcpSession, setStartingAcpSession] = useState(false);
  const [acpSessionGoal, setAcpSessionGoal] = useState("");

  const refreshAcpSessions = useCallback(async () => {
    setLoadingAcpSessions(true);
    setError(null);
    try {
      const rows = await listAcpSessions({
        projectId: effectiveProjectId ? effectiveProjectId : undefined,
        limit: 200,
      });
      setAcpSessions(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAcpSessions(false);
    }
  }, [effectiveProjectId, setError]);

  useEffect(() => {
    if (!active) return;
    void refreshAcpSessions();
  }, [active, refreshAcpSessions, reloadToken]);

  useEffect(() => {
    onLoadingChange?.(loadingAcpSessions);
  }, [loadingAcpSessions, onLoadingChange]);

  const onCancelAcpSession = useCallback(
    async (runId: string, sessionId: string) => {
      setError(null);
      if (!requireAdmin()) return;
      if (!window.confirm(`确认关闭 ACP session？\n\nrunId: ${runId}\nsessionId: ${sessionId}`)) return;

      const key = `${runId}:${sessionId}`;
      setCancelingAcpSessionKey(key);
      try {
        await cancelAcpSession(runId, sessionId);
        await refreshAcpSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCancelingAcpSessionKey("");
      }
    },
    [refreshAcpSessions, requireAdmin, setError],
  );

  const onStartAcpSession = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先选择 Project");
      return;
    }

    setStartingAcpSession(true);
    try {
      const res = await startAcpSession({
        projectId: effectiveProjectId,
        goal: acpSessionGoal.trim() ? acpSessionGoal.trim() : undefined,
      });
      setAcpSessionGoal("");
      await refreshAcpSessions();
      navigate(`/sessions/${res.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingAcpSession(false);
    }
  }, [acpSessionGoal, effectiveProjectId, navigate, refreshAcpSessions, requireAdmin, setError]);

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <h2 style={{ marginTop: 0 }}>ACP Sessions</h2>
      <div className="muted">
        列出当前项目下已建立的 ACP session（来自 Run.acpSessionId），可手动发送 <code>session/cancel</code> 关闭遗留会话。
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="muted">快速启动一个独立 Session（会创建隐藏 Issue + 单步 Task，并打开全屏控制台）。</div>
        <div className="row gap" style={{ alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
          <label className="label" style={{ margin: 0, flex: "2 1 320px", minWidth: 240 }}>
            目标（可选）
            <textarea
              value={acpSessionGoal}
              onChange={(e) => setAcpSessionGoal(e.target.value)}
              rows={3}
              placeholder="例如：修复登录；实现导入；排查构建失败…"
            />
          </label>
          <button type="button" onClick={onStartAcpSession} disabled={!effectiveProjectId || startingAcpSession}>
            {startingAcpSession ? "启动中…" : "启动 Session"}
          </button>
        </div>
      </div>

      {loadingAcpSessions ? (
        <div className="muted" style={{ marginTop: 12 }}>
          加载中…
        </div>
      ) : acpSessions.length ? (
        <div className="tableScroll">
          <table className="table tableWrap">
            <thead>
              <tr>
                <th>sessionId</th>
                <th>Agent</th>
                <th>Session 状态</th>
                <th>Run 状态</th>
                <th>Issue</th>
                <th>Run</th>
                <th>Console</th>
                <th>开始时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {acpSessions.map((s) => {
                const key = `${s.runId}:${s.sessionId}`;
                const busy = cancelingAcpSessionKey === key;
                return (
                  <tr key={key}>
                    <td>
                      <code title={s.sessionId}>{s.sessionId}</code>
                    </td>
                    <td>
                      {s.agent ? (
                        <span className="row gap" style={{ alignItems: "center" }}>
                          <span title={s.agent.proxyId}>{s.agent.name}</span>
                          <StatusBadge status={s.agent.status} />
                        </span>
                      ) : (
                        <span className="muted">未绑定</span>
                      )}
                    </td>
                    <td>
                      {s.sessionState ? (
                        <div>
                          <span className="row gap" style={{ alignItems: "center" }}>
                            <StatusBadge status={s.sessionState.activity} />
                            {s.sessionState.inFlight ? <span className="muted">inFlight={s.sessionState.inFlight}</span> : null}
                          </span>
                          <div className="muted" style={{ marginTop: 4 }}>
                            {s.sessionState.currentModeId ? (
                              <>
                                mode: <code>{s.sessionState.currentModeId}</code>
                              </>
                            ) : (
                              "mode: -"
                            )}
                            {s.sessionState.currentModelId ? (
                              <>
                                {" "}
                                · model: <code>{s.sessionState.currentModelId}</code>
                              </>
                            ) : (
                              " · model: -"
                            )}
                            {s.sessionState.lastStopReason ? ` · stop: ${s.sessionState.lastStopReason}` : ""}
                            {s.sessionState.note ? ` · note: ${s.sessionState.note}` : ""}
                            {s.sessionState.updatedAt ? ` · ${new Date(s.sessionState.updatedAt).toLocaleString()}` : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={s.runStatus} />
                    </td>
                    <td>
                      <div className="cellStack">
                        <Link to={`/issues/${s.issueId}`}>{s.issueTitle || s.issueId}</Link>
                        {s.issueTitle ? (
                          <div className="cellSub">
                            <code title={s.issueId}>{s.issueId}</code>
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <code title={s.runId}>{s.runId.slice(0, 8)}…</code>
                    </td>
                    <td>
                      <Link className="buttonSecondary" to={`/sessions/${s.runId}`}>
                        打开
                      </Link>
                    </td>
                    <td className="muted">{new Date(s.startedAt).toLocaleString()}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => void onCancelAcpSession(s.runId, s.sessionId)}
                        disabled={busy || !s.agent}
                        title={!s.agent ? "该 Run 未绑定 Agent（无法下发 session/cancel）" : ""}
                      >
                        {busy ? "关闭中…" : "关闭"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 12 }}>
          暂无 ACP session
        </div>
      )}
    </section>
  );
}
