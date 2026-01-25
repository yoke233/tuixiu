import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getIssue } from "../api/issues";
import { cancelRun, getRun, listRunEvents } from "../api/runs";
import { ArtifactList } from "../components/ArtifactList";
import { EventList } from "../components/EventList";
import { StatusBadge } from "../components/StatusBadge";
import { useWsClient, type WsMessage } from "../hooks/useWsClient";
import type { Event, Issue, Run } from "../types";

export function IssueDetailPage() {
  const params = useParams();
  const issueId = params.id ?? "";

  const [issue, setIssue] = useState<Issue | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentRunId = useMemo(() => run?.id ?? issue?.runs?.[0]?.id ?? "", [issue, run]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const i = await getIssue(issueId);
      setIssue(i);
      const rid = i.runs?.[0]?.id ?? "";
      if (rid) {
        const [r, es] = await Promise.all([getRun(rid), listRunEvents(rid)]);
        setRun(r);
        setEvents(es);
      } else {
        setRun(null);
        setEvents([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => {
    if (!issueId) return;
    refresh();
  }, [issueId, refresh]);

  const onWs = useCallback(
    (msg: WsMessage) => {
      if (!currentRunId) return;
      if (msg.run_id !== currentRunId) return;
      if (msg.type !== "event_added" && msg.type !== "artifact_added") return;
      refresh();
    },
    [currentRunId, refresh]
  );
  const ws = useWsClient(onWs);

  async function onCancelRun() {
    if (!currentRunId) return;
    setError(null);
    try {
      const r = await cancelRun(currentRunId);
      setRun(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="container">
      <div className="row spaceBetween">
        <Link to="/issues">← 返回</Link>
        <div className="muted">WS: {ws.status}</div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
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
                <button onClick={refresh}>刷新</button>
                <button onClick={onCancelRun} disabled={!currentRunId}>
                  取消 Run
                </button>
              </div>
            </div>

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
              </div>
            ) : (
              <div className="muted">暂无 Run</div>
            )}
          </section>

          <section className="grid2">
            <div className="card">
              <h2>Events</h2>
              <EventList events={events} />
            </div>
            <div className="card">
              <h2>Artifacts</h2>
              <ArtifactList artifacts={run?.artifacts ?? []} />
            </div>
          </section>
        </>
      ) : (
        <div className="muted">Issue 不存在</div>
      )}
    </div>
  );
}
