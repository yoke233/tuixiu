import { Link } from "react-router-dom";

import { ThemeToggle } from "@/components/ThemeToggle";
import type { IssueDetailController } from "@/pages/issueDetail/useIssueDetailController";

export function PageHeader(props: { model: IssueDetailController }) {
  const { refreshing, ws } = props.model;

  return (
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
  );
}

