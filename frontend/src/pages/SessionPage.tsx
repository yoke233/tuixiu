import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { getIssue } from "../api/issues";
import { getRun, listRunEvents, pauseRun, promptRun } from "../api/runs";
import { useAuth } from "../auth/AuthContext";
import { RunConsole } from "../components/RunConsole";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import { useWsClient, type WsMessage } from "../hooks/useWsClient";
import type { Event, Issue, Run } from "../types";

type SessionState = {
  sessionId: string;
  activity: string;
  inFlight: number;
  updatedAt: string;
  currentModeId: string | null;
  currentModelId: string | null;
  lastStopReason: string | null;
  note: string | null;
};

function readSessionState(events: Event[]): SessionState | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const payload = (events[i] as any)?.payload;
    if (!payload || typeof payload !== "object") continue;
    if ((payload as any).type !== "session_state") continue;

    const sessionId = typeof (payload as any).session_id === "string" ? String((payload as any).session_id) : "";
    if (!sessionId) continue;

    const activity = typeof (payload as any).activity === "string" ? String((payload as any).activity) : "unknown";
    const inFlightRaw = (payload as any).in_flight;
    const inFlight = typeof inFlightRaw === "number" && Number.isFinite(inFlightRaw) ? Math.max(0, inFlightRaw) : 0;
    const updatedAt = typeof (payload as any).updated_at === "string" ? String((payload as any).updated_at) : "";
    const currentModeId = typeof (payload as any).current_mode_id === "string" ? String((payload as any).current_mode_id) : null;
    const currentModelId = typeof (payload as any).current_model_id === "string" ? String((payload as any).current_model_id) : null;
    const lastStopReason = typeof (payload as any).last_stop_reason === "string" ? String((payload as any).last_stop_reason) : null;
    const note = typeof (payload as any).note === "string" ? String((payload as any).note) : null;

    return {
      sessionId,
      activity,
      inFlight,
      updatedAt,
      currentModeId,
      currentModelId,
      lastStopReason,
      note
    };
  }
  return null;
}

export function SessionPage() {
  const { runId = "" } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [run, setRun] = useState<Run | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatText, setChatText] = useState("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);

  const sessionState = useMemo(() => readSessionState(events), [events]);
  const sessionId = run?.acpSessionId ?? null;

  function requireLogin(): boolean {
    if (auth.user) return true;
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    navigate(`/login?next=${next}`);
    return false;
  }

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!runId) return;
      if (!opts?.silent) setRefreshing(true);
      setError(null);
      try {
        const r = await getRun(runId);
        setRun(r);

        const [es, iss] = await Promise.all([listRunEvents(runId), getIssue(r.issueId)]);
        setEvents([...es].reverse());
        setIssue(iss);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts?.silent) setRefreshing(false);
        setLoading(false);
      }
    },
    [runId]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onWs = useCallback(
    (msg: WsMessage) => {
      if (!runId) return;
      if (msg.run_id !== runId) return;

      if (msg.type === "event_added" && msg.event) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event!.id)) return prev;
          const next = [...prev, msg.event!];
          return next.length > 800 ? next.slice(next.length - 800) : next;
        });

        const payload = (msg.event as any).payload;
        if (payload?.type === "prompt_result") {
          setRun((r) => (r ? { ...r, status: "completed", completedAt: r.completedAt ?? new Date().toISOString() } : r));
          void refresh({ silent: true });
        }
        if (payload?.type === "init_result" && payload?.ok === false) {
          setRun((r) => (r ? { ...r, status: "failed", completedAt: r.completedAt ?? new Date().toISOString() } : r));
          void refresh({ silent: true });
        }
        if (payload?.type === "session_created" && typeof payload.session_id === "string") {
          setRun((r) => (r ? { ...r, acpSessionId: payload.session_id } : r));
        }
        return;
      }

      if (msg.type === "artifact_added" && msg.artifact) {
        setRun((r) => {
          if (!r) return r;
          const artifacts = [...(r.artifacts ?? [])];
          if (!artifacts.some((a) => a.id === msg.artifact!.id)) artifacts.unshift(msg.artifact!);

          const branch = (msg.artifact as any)?.type === "branch" ? (msg.artifact as any)?.content?.branch : undefined;
          const branchName = typeof branch === "string" ? branch : r.branchName;

          return { ...r, artifacts, branchName };
        });
      }
    },
    [refresh, runId]
  );
  const ws = useWsClient(onWs);

  async function onPause() {
    if (!runId) return;
    if (!requireLogin()) return;
    setError(null);
    setPausing(true);
    try {
      await pauseRun(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPausing(false);
    }
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!runId) return;
    if (!requireLogin()) return;

    const text = chatText.trim();
    if (!text) return;

    setError(null);
    setSending(true);
    try {
      await promptRun(runId, text);
      setChatText("");
      void refresh({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="sessionShell">
      <aside className="sessionSide">
        <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Session 控制台</div>
            <div className="muted">WS: {ws.status}{refreshing ? " · 同步中…" : ""}</div>
          </div>
          <ThemeToggle />
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          <section className="card">
            <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
              <div style={{ fontWeight: 800 }}>导航</div>
              <button type="button" className="buttonSecondary" onClick={() => void refresh()} disabled={refreshing || !runId}>
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
                  {run.workspacePath ? <code title={run.workspacePath}>{run.workspacePath}</code> : <span className="muted">-</span>}
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
              <div className="muted" style={{ marginTop: 10 }}>
                {sessionState.inFlight ? `inFlight=${sessionState.inFlight} · ` : ""}
                {sessionState.currentModeId ? `mode=${sessionState.currentModeId} · ` : ""}
                {sessionState.currentModelId ? `model=${sessionState.currentModelId} · ` : ""}
                {sessionState.lastStopReason ? `stop=${sessionState.lastStopReason} · ` : ""}
                {sessionState.updatedAt ? new Date(sessionState.updatedAt).toLocaleString() : ""}
                {sessionState.note ? ` · ${sessionState.note}` : ""}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 10 }}>
                暂无 session_state（等待 Agent 上报）
              </div>
            )}
          </section>
        </div>
      </aside>

      <main className="sessionMain">
        <section className="card sessionMobileHeader">
          <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
            <div className="row gap">
              <Link className="buttonSecondary" to="/issues">
                ← 看板
              </Link>
              {issue?.id ? (
                <Link className="buttonSecondary" to={`/issues/${issue.id}`}>
                  Issue
                </Link>
              ) : null}
              <Link className="buttonSecondary" to="/admin?section=acpSessions">
                Sessions
              </Link>
            </div>
            <div className="row gap" style={{ justifyContent: "flex-end" }}>
              <div className="muted">
                WS: {ws.status}
                {refreshing ? " · 同步中…" : ""}
              </div>
              <ThemeToggle />
            </div>
          </div>
        </section>

        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}

        <section className="card sessionConsoleCard">
          <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800 }}>Console</div>
              <div className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {issue?.title ?? "—"}
              </div>
            </div>
            <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" className="buttonSecondary" onClick={onPause} disabled={!runId || pausing || !sessionId}>
                {pausing ? "暂停中…" : "暂停"}
              </button>
            </div>
          </div>

          <div className="sessionConsoleBody">
            <RunConsole events={events} />
          </div>

          <form onSubmit={onSend} className="consoleInput">
            <input
              aria-label="对话输入"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder={!auth.user ? "登录后可继续对话…" : "像 CLI 一样继续对话…"}
              disabled={!auth.user || sending}
            />
            <button type="submit" disabled={!auth.user || sending || !chatText.trim()}>
              发送
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

