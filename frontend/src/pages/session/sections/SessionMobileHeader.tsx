import { Link } from "react-router-dom";

import { ThemeToggle } from "../../../components/ThemeToggle";
import type { SessionController } from "../useSessionController";

export function SessionMobileHeader(props: { model: SessionController }) {
  const { issue, refreshing, ws } = props.model;

  return (
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
            ACP Proxies
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
  );
}
