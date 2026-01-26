import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";

import { listAgents } from "../api/agents";
import { getIssue, startIssue } from "../api/issues";
import { cancelRun, completeRun, getRun, listRunEvents, promptRun } from "../api/runs";
import { ArtifactList } from "../components/ArtifactList";
import { RunChangesPanel } from "../components/RunChangesPanel";
import { RunConsole } from "../components/RunConsole";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import { useWsClient, type WsMessage } from "../hooks/useWsClient";
import type { Agent, Event, Issue, Run } from "../types";

type IssuesOutletContext = {
  onIssueUpdated?: (issue: Issue) => void;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function platformLabel(platform: string | null): string {
  switch (platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return platform ? platform : "未知";
  }
}

function getAgentEnvLabel(agent: Agent | null): string | null {
  if (!agent) return null;
  const caps = isRecord(agent.capabilities) ? agent.capabilities : null;
  const runtime = caps && isRecord(caps.runtime) ? caps.runtime : null;
  const platform = runtime && typeof runtime.platform === "string" ? runtime.platform : null;
  const isWsl = runtime && typeof runtime.isWsl === "boolean" ? runtime.isWsl : null;
  if (isWsl) return "WSL2";
  return platformLabel(platform);
}

function getAgentSandboxLabel(agent: Agent | null): { label: string; details?: string } | null {
  if (!agent) return null;
  const caps = isRecord(agent.capabilities) ? agent.capabilities : null;
  const sandbox = caps && isRecord(caps.sandbox) ? caps.sandbox : null;
  const provider = sandbox && typeof sandbox.provider === "string" ? sandbox.provider : null;
  if (!provider) return null;

  if (provider === "boxlite_oci" && sandbox) {
    const boxlite = isRecord(sandbox.boxlite) ? sandbox.boxlite : null;
    const image = boxlite && typeof boxlite.image === "string" ? boxlite.image : "";
    return { label: "boxlite_oci", details: image || undefined };
  }

  return { label: provider };
}

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
  const [chatText, setChatText] = useState<string>("");
  const [sending, setSending] = useState(false);
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
      await startIssue(issueId, { agentId: selectedAgentId || undefined });
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

          <section className="card">
            <div className="row spaceBetween">
              <h2>Run</h2>
              <div className="row gap">
                <button onClick={() => refresh()}>刷新</button>
                {currentRunId ? (
                  <>
                    <button onClick={onCancelRun} disabled={!currentRunId}>
                      取消 Run
                    </button>
                    <button onClick={onCompleteRun} disabled={!currentRunId}>
                      完成 Run
                    </button>
                  </>
                ) : (
                  <button onClick={onStartRun} disabled={!canStartRun}>
                    启动 Run
                  </button>
                )}
              </div>
            </div>

            {!run && agentsLoaded && !agentsError && availableAgents.length === 0 ? (
              <div className="muted" style={{ marginTop: 8 }}>
                当前没有可用的在线 Agent：请先启动 `acp-proxy`（或等待 Agent 空闲）。
              </div>
            ) : null}

            {!run && agentsError ? (
              <div className="muted" style={{ marginTop: 8 }} title={agentsError}>
                无法获取 Agent 列表：仍可尝试启动 Run（将由后端自动分配；如无 Agent 会返回错误）。
              </div>
            ) : null}

            {run ? (
              <div className="row gap">
                <div>
                  <div className="muted">runId</div>
                  <code>{run.id}</code>
                </div>
                <div>
                  <div className="muted">status</div>
                  <StatusBadge status={run.status} />
                </div>
                <div>
                  <div className="muted">agentId</div>
                  <code>{run.agentId}</code>
                </div>
                <div>
                  <div className="muted">agent</div>
                  <span className="row gap" style={{ alignItems: "center" }}>
                    {currentAgent ? (
                      <>
                        <StatusBadge status={currentAgent.status} />
                        <span className="muted">{currentAgent.name}</span>
                      </>
                    ) : (
                      <span className="muted">未知</span>
                    )}
                    {currentAgent ? (
                      <span className="muted">
                        {currentAgent.currentLoad}/{currentAgent.maxConcurrentRuns}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div>
                  <div className="muted">环境</div>
                  <span className="muted">{currentAgentEnvLabel ?? "未知"}</span>
                </div>
                <div>
                  <div className="muted">sandbox</div>
                  {currentAgentSandbox ? (
                    <span className="muted" title={currentAgentSandbox.details ?? ""}>
                      {currentAgentSandbox.label}
                    </span>
                  ) : (
                    <span className="muted">未知</span>
                  )}
                </div>
                <div>
                  <div className="muted">session</div>
                  {sessionKnown ? <code title={sessionId ?? ""}>{sessionId}</code> : <span className="muted">未建立</span>}
                </div>
              </div>
            ) : (
              <div className="row gap">
                <label className="label" style={{ margin: 0 }}>
                  选择 Agent（可选）
                  <select value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)}>
                    <option value="">自动分配</option>
                    {agents.map((a) => {
                      const sandbox = getAgentSandboxLabel(a);
                      const disabled = a.status !== "online" || a.currentLoad >= a.maxConcurrentRuns;
                      return (
                        <option key={a.id} value={a.id} disabled={disabled}>
                          {a.name} ({a.status} {a.currentLoad}/{a.maxConcurrentRuns}
                          {sandbox?.label ? ` · ${sandbox.label}` : ""})
                        </option>
                      );
                    })}
                  </select>
                </label>
                <div className="muted">
                  暂无 Run
                  {selectedAgent ? (
                    <span>
                      {" · "}
                      {selectedAgentEnvLabel ?? "未知"}
                      {selectedAgentSandbox?.label ? ` · ${selectedAgentSandbox.label}` : ""}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </section>

          <section className="card">
            <h2>Console</h2>
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
