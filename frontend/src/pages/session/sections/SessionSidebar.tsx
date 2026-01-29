import { ThemeToggle } from "../../../components/ThemeToggle";
import type { SessionController } from "../useSessionController";
import { SessionSidebarContent } from "./SessionSidebarContent";

export function SessionSidebar(props: { model: SessionController }) {
  const { ws, refreshing } = props.model;

  return (
    <aside className="sessionSide">
      <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 18 }}>Session 控制台</div>
          <div className="muted">
            WS: {ws.status}
            {refreshing ? " · 同步中…" : ""}
          </div>
        </div>
        <ThemeToggle />
      </div>

      <SessionSidebarContent model={props.model} />
    </aside>
  );
}
