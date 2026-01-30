import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { cancelAcpSession, listAcpSessions, setAcpSessionMode, startAcpSession } from "../../../api/acpSessions";
import { listAgents } from "../../../api/agents";
import { reportSandboxInventory, listSandboxes } from "../../../api/sandboxes";
import { StatusBadge } from "../../../components/StatusBadge";
import type { AcpSessionSummary, Agent, SandboxSummary } from "../../../types";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  reloadToken: number;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function AcpSessionsSection(props: Props) {
  const { active, effectiveProjectId, reloadToken, requireAdmin, setError, onLoadingChange } =
    props;
  const navigate = useNavigate();

  const [acpSessions, setAcpSessions] = useState<AcpSessionSummary[]>([]);
  const [loadingAcpSessions, setLoadingAcpSessions] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([]);
  const [sandboxesTotal, setSandboxesTotal] = useState(0);
  const [loadingAcpProxies, setLoadingAcpProxies] = useState(false);
  const [reportingInventoryProxyId, setReportingInventoryProxyId] = useState<string>("");
  const [cancelingAcpSessionKey, setCancelingAcpSessionKey] = useState<string>("");
  const [settingModeKey, setSettingModeKey] = useState<string>("");
  const [startingAcpSession, setStartingAcpSession] = useState(false);
  const [acpSessionGoal, setAcpSessionGoal] = useState("");

  const loading = loadingAcpSessions || loadingAcpProxies;

  const sandboxesByProxy = useMemo(() => {
    const byProxy = new Map<string, SandboxSummary[]>();
    for (const s of sandboxes) {
      const list = byProxy.get(s.proxyId) ?? [];
      list.push(s);
      byProxy.set(s.proxyId, list);
    }

    const ts = (v: string | null) => (v ? new Date(v).getTime() : 0);
    for (const list of byProxy.values()) {
      list.sort((a, b) => ts(b.sandboxLastSeenAt) - ts(a.sandboxLastSeenAt));
    }

    return byProxy;
  }, [sandboxes]);

  const proxies = useMemo(() => {
    const byId = new Map<string, { proxyId: string; agent: Agent | null }>();
    for (const agent of agents) {
      byId.set(agent.proxyId, { proxyId: agent.proxyId, agent });
    }
    for (const s of sandboxes) {
      if (!byId.has(s.proxyId)) byId.set(s.proxyId, { proxyId: s.proxyId, agent: null });
    }

    const rank = (row: { agent: Agent | null }) => {
      const status = row.agent?.status ?? "offline";
      if (status === "online") return 0;
      if (status === "degraded") return 1;
      if (status === "suspended") return 2;
      return 3;
    };

    return Array.from(byId.values()).sort((a, b) => {
      const ar = rank(a);
      const br = rank(b);
      if (ar !== br) return ar - br;
      const an = (a.agent?.name ?? "").toLowerCase();
      const bn = (b.agent?.name ?? "").toLowerCase();
      if (an !== bn) return an.localeCompare(bn);
      return a.proxyId.localeCompare(b.proxyId);
    });
  }, [agents, sandboxes]);

  const refreshAcpProxies = useCallback(async () => {
    setLoadingAcpProxies(true);
    setError(null);
    try {
      const [as, sb] = await Promise.all([listAgents(), listSandboxes({ limit: 500, offset: 0 })]);
      setAgents(as);
      setSandboxes(sb.sandboxes);
      setSandboxesTotal(sb.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAcpProxies(false);
    }
  }, [setError]);

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
    if (!requireAdmin()) return;
    void refreshAcpProxies();
    void refreshAcpSessions();
  }, [active, refreshAcpProxies, refreshAcpSessions, reloadToken, requireAdmin]);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  const onReportInventory = useCallback(
    async (proxyId: string) => {
      setError(null);
      if (!requireAdmin()) return;
      setReportingInventoryProxyId(proxyId);
      try {
        await reportSandboxInventory(proxyId);
        setTimeout(() => void refreshAcpProxies(), 800);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setReportingInventoryProxyId("");
      }
    },
    [refreshAcpProxies, requireAdmin, setError],
  );

  const onCancelAcpSession = useCallback(
    async (runId: string, sessionId: string) => {
      setError(null);
      if (!requireAdmin()) return;
      if (!window.confirm(`确认关闭 ACP session？\n\nrunId: ${runId}\nsessionId: ${sessionId}`))
        return;

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

  const onSetAcpSessionMode = useCallback(
    async (runId: string, sessionId: string, currentMode?: string | null) => {
      setError(null);
      if (!requireAdmin()) return;

      const hint = currentMode ? `当前：${currentMode}` : "例如：balanced";
      const input = window.prompt(`请输入 modeId（${hint}）`);
      const modeId = input ? input.trim() : "";
      if (!modeId) return;

      const key = `${runId}:${sessionId}`;
      setSettingModeKey(key);
      try {
        await setAcpSessionMode(runId, sessionId, modeId);
        await refreshAcpSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingModeKey("");
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
    <div hidden={!active}>
      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>ACP Proxies</h2>
        <div className="muted">
          显示当前已注册的 acp-proxy（Agent），以及各 proxy 上报的实例（sandbox inventory）。
        </div>

        {loadingAcpProxies ? (
          <div className="muted" style={{ marginTop: 12 }}>
            加载中…
          </div>
        ) : proxies.length ? (
          <div style={{ marginTop: 12 }}>
            {sandboxesTotal > 500 ? (
              <div className="muted" style={{ marginBottom: 8 }}>
                仅显示最近 500 个实例（total={sandboxesTotal}），如需查看更多请扩展分页。
              </div>
            ) : null}

            {proxies.map(({ proxyId, agent }) => {
              const instances = sandboxesByProxy.get(proxyId) ?? [];
              const aliveCount = instances.filter(
                (s) => s.sandboxStatus === "running" || s.sandboxStatus === "creating",
              ).length;
              const deadCount = instances.length - aliveCount;
              const reporting = reportingInventoryProxyId === proxyId;

              return (
                <details key={proxyId} style={{ marginTop: 10 }} open={proxies.length === 1}>
                  <summary style={{ cursor: "pointer" }}>
                    <span className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 800 }}>{agent?.name ?? "未注册 Proxy"}</span>
                      <code title={proxyId}>{proxyId}</code>
                      <StatusBadge status={agent?.status ?? "offline"} />
                      {agent ? (
                        <span className="muted">
                          load {agent.currentLoad}/{agent.maxConcurrentRuns}
                        </span>
                      ) : null}
                      <span className="muted">
                        实例：{aliveCount} 存活 / {deadCount} 未存活 / {instances.length} 总计
                      </span>
                    </span>
                  </summary>

                  <div style={{ marginTop: 10 }}>
                    <div
                      className="row gap"
                      style={{ alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}
                    >
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => void onReportInventory(proxyId)}
                        disabled={reporting}
                      >
                        {reporting ? "请求中…" : "请求 inventory"}
                      </button>
                      <span className="muted">
                        下发 report_inventory 后，实例列表会异步更新（可点右上角刷新）。
                      </span>
                    </div>

                    {instances.length ? (
                      <div className="tableScroll">
                        <table className="table tableWrap">
                          <thead>
                            <tr>
                              <th>instance</th>
                              <th>状态</th>
                              <th>provider</th>
                              <th>runtime</th>
                              <th>lastSeen</th>
                              <th>Issue</th>
                              <th>Run</th>
                              <th>Console</th>
                              <th>error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {instances.map((s) => (
                              <tr key={`${s.proxyId}:${s.instanceName}`}>
                                <td>
                                  <code title={s.instanceName}>{s.instanceName}</code>
                                </td>
                                <td>
                                  <StatusBadge status={s.sandboxStatus ?? "unknown"} />
                                </td>
                                <td>
                                  {s.provider ? (
                                    <code>{s.provider}</code>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                                <td>
                                  {s.runtime ? (
                                    <code>{s.runtime}</code>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                                <td className="muted">
                                  {s.sandboxLastSeenAt
                                    ? new Date(s.sandboxLastSeenAt).toLocaleString()
                                    : "-"}
                                </td>
                                <td>
                                  {s.issueId ? (
                                    <Link to={`/issues/${s.issueId}`}>
                                      <code title={s.issueId}>{s.issueId.slice(0, 8)}…</code>
                                    </Link>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                                <td>
                                  {s.runId ? (
                                    <code title={s.runId}>{s.runId.slice(0, 8)}…</code>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                                <td>
                                  {s.runId ? (
                                    <Link className="buttonSecondary" to={`/sessions/${s.runId}`}>
                                      打开
                                    </Link>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                                <td>
                                  {s.sandboxLastError ? (
                                    <code title={s.sandboxLastError}>{s.sandboxLastError}</code>
                                  ) : (
                                    <span className="muted">-</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="muted">暂无实例</div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 12 }}>
            暂无 acp-proxy 注册（请确认 acp-proxy 已连接 backend WebSocket，并成功发送
            register_agent）。
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <h2 style={{ marginTop: 0 }}>ACP Sessions</h2>
        <div className="muted">
          列出当前项目下已建立的 ACP session（来自 Run.acpSessionId），可手动发送{" "}
          <code>session/cancel</code> 关闭遗留会话。
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="muted">
            快速启动一个独立 Session（会创建隐藏 Issue + 单步 Task，并打开全屏控制台）。
          </div>
          <div
            className="row gap"
            style={{ alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}
          >
            <label className="label" style={{ margin: 0, flex: "2 1 320px", minWidth: 240 }}>
              目标（可选）
              <textarea
                value={acpSessionGoal}
                onChange={(e) => setAcpSessionGoal(e.target.value)}
                rows={3}
                placeholder="例如：修复登录；实现导入；排查构建失败…"
              />
            </label>
            <button
              type="button"
              onClick={onStartAcpSession}
              disabled={!effectiveProjectId || startingAcpSession}
            >
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
                  const busy = cancelingAcpSessionKey === key || settingModeKey === key;
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
                              {s.sessionState.inFlight ? (
                                <span className="muted">inFlight={s.sessionState.inFlight}</span>
                              ) : null}
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
                              {s.sessionState.lastStopReason
                                ? ` · stop: ${s.sessionState.lastStopReason}`
                                : ""}
                              {s.sessionState.note ? ` · note: ${s.sessionState.note}` : ""}
                              {s.sessionState.updatedAt
                                ? ` · ${new Date(s.sessionState.updatedAt).toLocaleString()}`
                                : ""}
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
                          onClick={() =>
                            void onSetAcpSessionMode(
                              s.runId,
                              s.sessionId,
                              s.sessionState?.currentModeId ?? null,
                            )
                          }
                          disabled={busy || !s.agent}
                          title={!s.agent ? "该 Run 未绑定 Agent（无法下发 session/set_mode）" : ""}
                        >
                          {settingModeKey === key ? "设置中…" : "设置 mode"}
                        </button>
                        <button
                          type="button"
                          className="buttonSecondary"
                          onClick={() => void onCancelAcpSession(s.runId, s.sessionId)}
                          disabled={busy || !s.agent}
                          title={!s.agent ? "该 Run 未绑定 Agent（无法下发 session/cancel）" : ""}
                          style={{ marginLeft: 8 }}
                        >
                          {cancelingAcpSessionKey === key ? "关闭中…" : "关闭"}
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
    </div>
  );
}
