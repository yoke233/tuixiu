import { Link } from "react-router-dom";

import { StatusBadge } from "../../../components/StatusBadge";
import type { Issue } from "../../../types";
import type { IssueListController } from "../useIssueListController";

function IssueCardLink(props: { model: IssueListController; issue: Issue }) {
  const { model, issue } = props;
  const {
    auth,
    canChangeStatus,
    canRun,
    dragging,
    isMobile,
    moving,
    selectedIssueId,
    setDragging,
    setDropStatus,
  } = model;

  const latestRun = issue.runs?.[0];
  const selected = selectedIssueId === issue.id;
  const isDragging = dragging?.issueId === issue.id;

  const detailPath =
    isMobile && latestRun?.id ? `/sessions/${latestRun.id}` : `/issues/${issue.id}`;

  return (
    <Link
      to={detailPath}
      draggable={Boolean(auth.user) && (canRun || canChangeStatus)}
      onDragStart={(e) => {
        if (!auth.user) return;
        if (!canRun && !canChangeStatus) return;
        const payload = { issueId: issue.id, fromStatus: issue.status, runId: latestRun?.id };
        setDragging(payload);
        e.dataTransfer.setData("application/json", JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        setDragging(null);
        setDropStatus(null);
      }}
      className={`issueCard ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
      aria-disabled={moving ? "true" : undefined}
    >
      <div className="issueTitle" title={issue.title}>
        {issue.title}
      </div>
      <div className="row spaceBetween issueMeta">
        <div className="muted">{new Date(issue.createdAt).toLocaleDateString()}</div>
        {latestRun ? (
          <div className="row gap issueCardRun" title={`最新 Run：${latestRun.id}`}>
            <span className="muted" style={{ fontSize: 12 }}>
              Run
            </span>
            <StatusBadge status={latestRun.status} />
          </div>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            Run —
          </span>
        )}
      </div>
    </Link>
  );
}

export function KanbanBoard(props: { model: IssueListController }) {
  const { columns, dropStatus, issuesByStatus, moveIssue, readDragPayload, setDropStatus } =
    props.model;

  return (
    <section className="kanban" aria-label="Issues 看板">
      {columns.map((c) => {
        const list = issuesByStatus[c.key];
        return (
          <div
            key={c.key}
            className={`kanbanCol ${dropStatus === c.key ? "dropTarget" : ""}`}
            aria-label={c.title}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropStatus(c.key);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const payload = readDragPayload(e);
              if (!payload) return;
              void moveIssue(payload, c.key);
            }}
          >
            <div className="kanbanColHeader">
              <div className="row gap">
                <span className={`dot ${c.dot}`} aria-hidden="true" />
                <div className="kanbanColTitle">{c.title}</div>
              </div>
              <div className="muted">{list.length}</div>
            </div>

            <div className="kanbanColBody">
              {list.length ? (
                list.map((i) => (
                  <div key={i.id} className="issueCardWrap">
                    <IssueCardLink model={props.model} issue={i} />
                  </div>
                ))
              ) : (
                <div className="muted kanbanEmpty">暂无</div>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
