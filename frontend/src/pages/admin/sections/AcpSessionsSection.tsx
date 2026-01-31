import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  cancelAcpSession,
  forceCloseAcpSession,
  listAcpSessions,
  setAcpSessionMode,
  startAcpSession,
} from "../../../api/acpSessions";
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
  const [forceClosingAcpSessionKey, setForceClosingAcpSessionKey] = useState<string>("");
  const [settingModeKey, setSettingModeKey] = useState<string>("");
  const [startingAcpSession, setStartingAcpSession] = useState(false);
  const [acpSessionGoal, setAcpSessionGoal] = useState("");
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionActivityFilter, setSessionActivityFilter] = useState<
    "all" | "running" | "problem" | "closed" | "unknown"
  >("running");
  const [onlyStale, setOnlyStale] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [selectedSessionKey, setSelectedSessionKey] = useState<string>("");

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

  const agentOptions = useMemo(() => {
    const byKey = new Map<string, { proxyId: string; label: string }>();
    for (const s of acpSessions) {
      if (!s.agent) continue;
      const proxyId = s.agent.proxyId;
      const label = `${s.agent.name} (${s.agent.status})`;
      byKey.set(proxyId, { proxyId, label });
    }
    return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [acpSessions]);

  const filteredAcpSessions = useMemo(() => {
    const q = sessionQuery.trim().toLowerCase();

    const isStaleSession = (s: AcpSessionSummary) => {
      const updatedAt = s.sessionState?.updatedAt ?? null;
      if (!updatedAt) return true;
      const ageMs = Date.now() - new Date(updatedAt).getTime();
      return ageMs > 90_000;
    };

    const matchesActivity = (s: AcpSessionSummary) => {
      const activity = s.sessionState?.activity ?? "unknown";
      if (sessionActivityFilter === "all") return true;
      if (sessionActivityFilter === "running") return activity === "busy" || activity === "loading" || activity === "idle";
      if (sessionActivityFilter === "problem")
        return activity === "unknown" || activity === "cancel_requested" || isStaleSession(s);
      if (sessionActivityFilter === "closed") return activity === "closed";
      if (sessionActivityFilter === "unknown") return activity === "unknown";
      return true;
    };

    const matchesQuery = (s: AcpSessionSummary) => {
      if (!q) return true;
      const hay = [
        s.sessionId,
        s.runId,
        s.issueId,
        s.issueTitle,
        s.agent?.name ?? "",
        s.agent?.proxyId ?? "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };

    return acpSessions.filter((s) => {
      if (onlyStale && !isStaleSession(s)) return false;
      if (agentFilter && (s.agent?.proxyId ?? "") !== agentFilter) return false;
      if (!matchesActivity(s)) return false;
      if (!matchesQuery(s)) return false;
      return true;
    });
  }, [acpSessions, agentFilter, onlyStale, sessionActivityFilter, sessionQuery]);

  const selectedSession = useMemo(() => {
    if (!selectedSessionKey) return null;
    return filteredAcpSessions.find((s) => `${s.runId}:${s.sessionId}` === selectedSessionKey) ?? null;
  }, [filteredAcpSessions, selectedSessionKey]);

  useEffect(() => {
    if (!filteredAcpSessions.length) {
      setSelectedSessionKey("");
      return;
    }
    if (selectedSessionKey && filteredAcpSessions.some((s) => `${s.runId}:${s.sessionId}` === selectedSessionKey)) {
      return;
    }
    const first = filteredAcpSessions[0];
    setSelectedSessionKey(first ? `${first.runId}:${first.sessionId}` : "");
  }, [filteredAcpSessions, selectedSessionKey]);

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

  const onForceCloseAcpSession = useCallback(
    async (runId: string, sessionId: string) => {
      setError(null);
      if (!requireAdmin()) return;
      if (
        !window.confirm(
          `确认强制关闭并从列表移除 ACP session？\n\nrunId: ${runId}\nsessionId: ${sessionId}\n\n说明：将清除 Run.acpSessionId（仅影响“会话管理”，不会删除 Run 记录）。`,
        )
      ) {
        return;
      }

      const key = `${runId}:${sessionId}`;
      setForceClosingAcpSessionKey(key);
      try {
        await forceCloseAcpSession(runId, sessionId);
        await refreshAcpSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setForceClosingAcpSessionKey("");
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
          <div style={{ marginTop: 12 }}>
            <div className="row gap" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
              <div className="row gap" style={{ alignItems: "flex-end" }}>
                <label className="label" style={{ margin: 0 }}>
                  搜索
                  <input
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.target.value)}
                    placeholder="sessionId / runId / issue / agent…"
                  />
                </label>
                <label className="label" style={{ margin: 0 }}>
                  视图
                  <select
                    value={sessionActivityFilter}
                    onChange={(e) => setSessionActivityFilter(e.target.value as any)}
                  >
                    <option value="running">运行中（idle/busy/loading）</option>
                    <option value="problem">问题（unknown/cancel_requested/stale）</option>
                    <option value="unknown">仅 unknown</option>
                    <option value="closed">仅 closed</option>
                    <option value="all">全部</option>
                  </select>
                </label>
                <label className="label" style={{ margin: 0 }}>
                  Agent
                  <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
                    <option value="">全部</option>
                    {agentOptions.map((a) => (
                      <option key={a.proxyId} value={a.proxyId}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label" style={{ margin: 0 }}>
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={onlyStale}
                      onChange={(e) => setOnlyStale(e.target.checked)}
                    />
                    仅 stale（{" > "}90s 未更新）
                  </span>
                </label>
              </div>

              <div className="row gap" style={{ alignItems: "center" }}>
                <span className="muted">显示 {filteredAcpSessions.length} / {acpSessions.length}</span>
                <button type="button" className="buttonSecondary" onClick={() => void refreshAcpSessions()}>
                  刷新 Sessions
                </button>
              </div>
            </div>

            <div className="adminSplit" style={{ marginTop: 12 }}>
              <div className="adminSplitList">
                <ul className="list" style={{ marginTop: 0 }}>
                  {filteredAcpSessions.map((s) => {
                    const key = `${s.runId}:${s.sessionId}`;
                    const activity = s.sessionState?.activity ?? "unknown";
                    const updatedAt = s.sessionState?.updatedAt ?? null;
                    const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
                    const isStale = typeof ageMs === "number" ? ageMs > 90_000 : true;

                    const selected = selectedSessionKey === key;
                    return (
                      <li key={key} className={`adminListItem ${selected ? "selected" : ""}`}>
                        <button
                          type="button"
                          className="adminListItemButton"
                          onClick={() => setSelectedSessionKey(key)}
                        >
                          <div className="row gap" style={{ alignItems: "center", justifyContent: "space-between" }}>
                            <span className="row gap" style={{ alignItems: "center", minWidth: 0 }}>
                              <code title={s.sessionId}>{s.sessionId.slice(0, 8)}…</code>
                              <StatusBadge status={activity} />
                              {isStale ? <span className="badge orange">stale</span> : null}
                              <StatusBadge status={s.runStatus} />
                            </span>
                            {s.agent ? (
                              <span className="muted" title={s.agent.proxyId}>
                                {s.agent.name}
                              </span>
                            ) : (
                              <span className="muted">未绑定</span>
                            )}
                          </div>
                          <div className="cellSub" style={{ marginTop: 6 }}>
                            {s.issueTitle ? s.issueTitle : s.issueId}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="adminSplitDetail">
                {selectedSession ? (
                  (() => {
                    const s = selectedSession;
                    const key = `${s.runId}:${s.sessionId}`;
                    const busy =
                      cancelingAcpSessionKey === key ||
                      forceClosingAcpSessionKey === key ||
                      settingModeKey === key;

                    const activity = s.sessionState?.activity ?? "unknown";
                    const updatedAt = s.sessionState?.updatedAt ?? null;
                    const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
                    const isStale = typeof ageMs === "number" ? ageMs > 90_000 : true;

                    return (
                      <div className="card" style={{ marginTop: 0 }}>
                        <div className="row spaceBetween" style={{ alignItems: "flex-start" }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="row gap" style={{ alignItems: "center" }}>
                              <h3 style={{ margin: 0 }}>Session</h3>
                              <StatusBadge status={activity} />
                              {isStale ? <span className="badge orange">stale</span> : null}
                              <StatusBadge status={s.runStatus} />
                            </div>
                            <div className="muted" style={{ marginTop: 6 }}>
                              {s.issueTitle ? s.issueTitle : s.issueId}
                            </div>
                          </div>
                          <div className="row gap" style={{ alignItems: "center", justifyContent: "flex-end" }}>
                            <Link className="buttonSecondary" to={`/sessions/${s.runId}`}>
                              打开控制台
                            </Link>
                            <Link className="buttonSecondary" to={`/issues/${s.issueId}`}>
                              打开 Issue
                            </Link>
                          </div>
                        </div>

                        <div className="kvTable" style={{ marginTop: 12 }}>
                          <dt>sessionId</dt>
                          <dd>
                            <code title={s.sessionId}>{s.sessionId}</code>
                          </dd>

                          <dt>runId</dt>
                          <dd>
                            <code title={s.runId}>{s.runId}</code>
                          </dd>

                          <dt>agent</dt>
                          <dd>
                            {s.agent ? (
                              <span className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                                <span title={s.agent.proxyId}>{s.agent.name}</span>
                                <StatusBadge status={s.agent.status} />
                                <code title={s.agent.proxyId}>{s.agent.proxyId}</code>
                              </span>
                            ) : (
                              <span className="muted">未绑定</span>
                            )}
                          </dd>

                          <dt>mode/model</dt>
                          <dd>
                            <span className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                              {s.sessionState?.currentModeId ? <code>{s.sessionState.currentModeId}</code> : <span className="muted">mode: -</span>}
                              {s.sessionState?.currentModelId ? <code>{s.sessionState.currentModelId}</code> : <span className="muted">model: -</span>}
                              {s.sessionState?.inFlight ? <span className="muted">inFlight={s.sessionState.inFlight}</span> : null}
                            </span>
                          </dd>

                          <dt>updated</dt>
                          <dd className="muted">
                            {updatedAt ? new Date(updatedAt).toLocaleString() : "-"}
                            {typeof ageMs === "number" ? ` · ${Math.round(ageMs / 1000)}s ago` : ""}
                          </dd>

                          <dt>run time</dt>
                          <dd className="muted">
                            {new Date(s.startedAt).toLocaleString()}
                            {s.completedAt ? ` · completed: ${new Date(s.completedAt).toLocaleString()}` : ""}
                          </dd>

                          <dt>note</dt>
                          <dd className="muted">{s.sessionState?.note ? s.sessionState.note : "-"}</dd>
                        </div>

                        <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 12 }}>
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
                          >
                            {cancelingAcpSessionKey === key ? "关闭中…" : "关闭"}
                          </button>
                          <button
                            type="button"
                            className="buttonSecondary buttonDanger"
                            onClick={() => void onForceCloseAcpSession(s.runId, s.sessionId)}
                            disabled={busy}
                            title="强制清除 Run.acpSessionId（用于清理遗留/无法下发的会话）"
                          >
                            {forceClosingAcpSessionKey === key ? "移除中…" : "强制移除"}
                          </button>
                        </div>

                        <details style={{ marginTop: 12 }}>
                          <summary className="muted" style={{ cursor: "pointer" }}>
                            原始 sessionState
                          </summary>
                          <pre className="pre">{JSON.stringify(s.sessionState, null, 2)}</pre>
                        </details>
                      </div>
                    );
                  })()
                ) : (
                  <div className="muted">请选择左侧一个 session 查看详情</div>
                )}
              </div>
            </div>
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
