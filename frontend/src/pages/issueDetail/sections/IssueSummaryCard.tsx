import { StatusBadge } from "../../../components/StatusBadge";
import type { IssueDetailController } from "../useIssueDetailController";

export function IssueSummaryCard(props: { model: IssueDetailController }) {
  const { issue } = props.model;
  if (!issue) return null;

  return (
    <section className="card">
      <h1>{issue.title}</h1>
      <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Issue
          </span>
          <StatusBadge status={issue.status} />
        </div>
        <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Run
          </span>
          {issue.runs?.[0] ? <StatusBadge status={issue.runs[0].status} /> : <span className="muted">—</span>}
        </div>
        <span className="muted">{new Date(issue.createdAt).toLocaleString()}</span>
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        Issue 状态表示需求在看板中的阶段；Run 状态表示该需求最近一次执行流程（Agent/CI/人工）的运行状态。
      </div>
      {issue.description ? (
        <pre className="pre" style={{ whiteSpace: "pre-wrap" }}>
          {issue.description}
        </pre>
      ) : null}
    </section>
  );
}

