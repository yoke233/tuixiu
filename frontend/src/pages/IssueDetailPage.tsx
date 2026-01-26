import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import { listAgents } from "../api/agents";
import { getIssue, startIssue } from "../api/issues";
import { listRoles } from "../api/roles";
import { cancelRun, completeRun, getRun, listRunEvents, pauseRun, promptRun } from "../api/runs";
import { ArtifactList } from "../components/ArtifactList";
import { IssueRunCard } from "../components/IssueRunCard";
import { RunChangesPanel } from "../components/RunChangesPanel";
import { RunConsole } from "../components/RunConsole";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import { useWsClient, type WsMessage } from "../hooks/useWsClient";
import type { Agent, Event, Issue, RoleTemplate, Run } from "../types";
import { getAgentEnvLabel, getAgentSandboxLabel } from "../utils/agentLabels";

type IssuesOutletContext = {
  onIssueUpdated?: (issue: Issue) => void;
};

export function IssueDetailPage() {
  const params = useParams();
  const issueId = params.id ?? "";
  const outlet = useOutletContext<IssuesOutletContext | null>();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const issueRef = useRef<Issue | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [selectedRoleKey, setSelectedRoleKey] = useState<string>("");
  const [worktreeName, setWorktreeName] = useState<string>("");
  const [chatText, setChatText] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);

  const currentRunId = useMemo(() => run?.id ?? issue?.runs?.[0]?.id ?? "", [issue, run]);
  const currentAgentId = useMemo(() => run?.agentId ?? issue?.runs?.[0]?.agentId ?? "", [issue, run]);
  const currentAgent = useMemo(
    () => (currentAgentId ? agents.find((a) => a.id === currentAgentId) ?? null : null),
    [agents, currentAgentId],
  );
  const agentOnline = currentAgent ? currentAgent.status === "online" : true;
  const currentAgentEnvLabel = useMemo(() => getAgentEnvLabel(currentAgent), [currentAgent]);
  const currentAgentSandbox = useMemo(() => getAgentSandboxLabel(currentAgent), [currentAgent]);

  const selectedAgent = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  );
  const selectedAgentEnvLabel = useMemo(() => getAgentEnvLabel(selectedAgent), [selectedAgent]);
  const selectedAgentSandbox = useMemo(() => getAgentSandboxLabel(selectedAgent), [selectedAgent]);

  const sessionId = run?.acpSessionId ?? null;
  const sessionKnown = !!sessionId;

  useEffect(() => {
    issueRef.current = issue;
  }, [issue]);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    const isInitial = !issueRef.current;
    if (!silent) {
      if (isInitial) setLoading(true);
      else setRefreshing(true);
    }
    setError(null);
    try {
      const i = await getIssue(issueId);
      setIssue(i);
      outlet?.onIssueUpdated?.(i);
      const rid = i.runs?.[0]?.id ?? "";
      if (rid) {
        const [r, es] = await Promise.all([getRun(rid), listRunEvents(rid)]);
        setRun(r);
        setEvents([...es].reverse());
      } else {
        setRun(null);
        setEvents([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) {
        if (isInitial) setLoading(false);
        else setRefreshing(false);
      }
    }
  }, [issueId, outlet]);

  useEffect(() => {
    if (!issueId) return;
    refresh();
  }, [issueId, refresh]);

  useEffect(() => {
    listAgents()
      .then((as) => {
        setAgents(as);
        setAgentsError(null);
        setAgentsLoaded(true);
      })
      .catch((err) => {
        setAgentsError(err instanceof Error ? err.message : String(err));
        setAgentsLoaded(true);
      });
  }, []);

  useEffect(() => {
    const projectId = issue?.projectId ?? "";
    if (!projectId) return;

    setRolesLoaded(false);
    setRolesError(null);
    listRoles(projectId)
      .then((rs) => {
        setRoles(rs);
        setRolesLoaded(true);
      })
      .catch((err) => {
        setRolesError(err instanceof Error ? err.message : String(err));
        setRolesLoaded(true);
      });
  }, [issue?.projectId]);

  useEffect(() => {
    if (!issue) return;
    if (selectedRoleKey) return;
    const def = issue.project?.defaultRoleKey;
    if (typeof def === "string" && def.trim()) setSelectedRoleKey(def.trim());
  }, [issue, selectedRoleKey]);

  const onWs = useCallback(
    (msg: WsMessage) => {
      if (!currentRunId) return;
      if (msg.run_id !== currentRunId) return;
      if (msg.type === "event_added" && msg.event) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event!.id)) return prev;
          const next = [...prev, msg.event!];
          return next.length > 600 ? next.slice(next.length - 600) : next;
        });

        const payload = (msg.event as any).payload;
        if (payload?.type === "prompt_result") {
          setRun((r) => (r ? { ...r, status: "completed", completedAt: r.completedAt ?? new Date().toISOString() } : r));
          setIssue((i) => {
            if (!i) return i;
            const next: Issue = { ...i, status: "reviewing" };
            outlet?.onIssueUpdated?.(next);
            return next;
          });
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
        return;
      }
    },
    [currentRunId, outlet]
  );
  const ws = useWsClient(onWs);

  const availableAgents = useMemo(
    () => agents.filter((a) => a.status === "online" && a.currentLoad < a.maxConcurrentRuns),
    [agents],
  );
  const selectedAgentReady = selectedAgent ? selectedAgent.status === "online" && selectedAgent.currentLoad < selectedAgent.maxConcurrentRuns : false;
  const canStartRun = Boolean(issueId) && (selectedAgentId ? selectedAgentReady : !agentsLoaded || !!agentsError || availableAgents.length > 0);

  async function onStartRun() {
    if (!issueId) return;
    setError(null);
    setRefreshing(true);
    try {
      await startIssue(issueId, {
        agentId: selectedAgentId || undefined,
        roleKey: selectedRoleKey || undefined,
        worktreeName: worktreeName.trim() ? worktreeName.trim() : undefined
      });
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onCancelRun() {
    if (!currentRunId) return;
    setError(null);
    try {
      const r = await cancelRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCompleteRun() {
    if (!currentRunId) return;
    setError(null);
    try {
      const r = await completeRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onPauseRun() {
    if (!currentRunId) return;
    setError(null);
    setPausing(true);
    try {
      await pauseRun(currentRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPausing(false);
    }
  }


  async function onSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!currentRunId) return;
    if (currentAgent && currentAgent.status !== "online") {
      setError("当前 Agent 已离线，无法继续对话");
      return;
    }
    const text = chatText.trim();
    if (!text) return;
    setError(null);
    setSending(true);
    try {
      await promptRun(currentRunId, text);
      setChatText("");
      await refresh({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="container">
      <div className="row spaceBetween">
        <Link to="/issues">← 返回</Link>
        <div className="row gap">
          <div className="muted">
            WS: {ws.status}
            {refreshing ? " · 同步中…" : ""}
          </div>
          <ThemeToggle />
        </div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      {loading && !issue ? (
        <div className="muted">加载中…</div>
      ) : issue ? (
        <>
          <section className="card">
            <h1>{issue.title}</h1>
            <div className="row gap">
              <StatusBadge status={issue.status} />
              <span className="muted">{new Date(issue.createdAt).toLocaleString()}</span>
            </div>
            {issue.description ? <p className="pre">{issue.description}</p> : null}
          </section>

          <IssueRunCard
            run={run}
            currentRunId={currentRunId}
            sessionId={sessionId}
            sessionKnown={sessionKnown}
            onRefresh={() => {
              void refresh();
            }}
            onStartRun={onStartRun}
            onCancelRun={onCancelRun}
            onCompleteRun={onCompleteRun}
            canStartRun={canStartRun}
            agents={agents}
            agentsLoaded={agentsLoaded}
            agentsError={agentsError}
            availableAgentsCount={availableAgents.length}
            currentAgent={currentAgent}
            currentAgentEnvLabel={currentAgentEnvLabel}
            currentAgentSandbox={currentAgentSandbox}
            selectedAgentId={selectedAgentId}
            onSelectedAgentIdChange={setSelectedAgentId}
            selectedAgent={selectedAgent}
            selectedAgentEnvLabel={selectedAgentEnvLabel}
            selectedAgentSandbox={selectedAgentSandbox}
            roles={roles}
            rolesLoaded={rolesLoaded}
            rolesError={rolesError}
            selectedRoleKey={selectedRoleKey}
            onSelectedRoleKeyChange={setSelectedRoleKey}
            worktreeName={worktreeName}
            onWorktreeNameChange={setWorktreeName}
          />

          <section className="card">
            <div className="row spaceBetween">
              <h2>Console</h2>
              {run?.status === "running" ? (
                <button
                  onClick={onPauseRun}
                  disabled={!currentRunId || pausing || !sessionKnown || (currentAgent ? !agentOnline : false)}
                  title={!sessionKnown ? "ACP sessionId 尚未建立/同步" : ""}
                >
                  {pausing ? "暂停中…" : "暂停 Agent"}
                </button>
              ) : null}
            </div>
            <RunConsole events={events} />
            <form onSubmit={onSendPrompt} className="consoleInput">
              <input
                aria-label="对话输入"
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder={currentRunId ? "像 CLI 一样继续对话…" : "请先启动 Run"}
                disabled={!currentRunId || sending || (currentAgent ? !agentOnline : false)}
              />
              <button
                type="submit"
                disabled={!currentRunId || sending || !chatText.trim() || (currentAgent ? !agentOnline : false)}
              >
                发送
              </button>
            </form>
            {currentRunId && currentAgent && !agentOnline ? (
              <div className="muted" style={{ marginTop: 8 }}>
                当前 Agent 离线：需要等待其重新上线，或重新启动新的 Run。
              </div>
            ) : currentRunId && !sessionKnown ? (
              <div className="muted" style={{ marginTop: 8 }}>
                ACP sessionId 还未同步到页面：proxy 会优先尝试复用/`session/load` 历史会话；仅在确实无法恢复时才会新建并注入上下文继续。
              </div>
            ) : null}
          </section>


          <section className="card">
            <details
              onToggle={(e) => {
                setChangesOpen((e.currentTarget as HTMLDetailsElement).open);
              }}
            >
              <summary className="detailsSummary">变更</summary>
              {changesOpen ? (
                <RunChangesPanel
                  runId={run?.id ?? ""}
                  run={run}
                  project={issue.project}
                  onRunUpdated={setRun}
                  onAfterAction={() => refresh({ silent: true })}
                />
              ) : (
                <div className="muted" style={{ padding: "10px 0" }}>
                  展开后加载变更与 diff
                </div>
              )}
            </details>
          </section>
          <section className="card">
            <details>
              <summary className="detailsSummary">
                交付物{run?.artifacts?.length ? ` (${run.artifacts.length})` : ""}
              </summary>
              <ArtifactList artifacts={run?.artifacts ?? []} />
            </details>
          </section>
        </>
      ) : (
        <div className="muted">Issue 不存在</div>
      )}
    </div>
  );
}
