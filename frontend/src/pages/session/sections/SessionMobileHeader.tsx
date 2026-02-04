import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { StatusBadge } from "@/components/StatusBadge";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { SessionController } from "@/pages/session/useSessionController";
import { SessionSidebarContent } from "@/pages/session/sections/SessionSidebarContent";
import { Button } from "@/components/ui/button";

export function SessionMobileHeader(props: { model: SessionController }) {
  const { issue, refreshing, run, sessionState, ws } = props.model;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const status = sessionState?.activity ?? run?.status;

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  return (
    <section className="sessionMobileHeader">
      <div className="sessionMobileHeaderRow">
        <Button asChild variant="secondary" size="sm" className="sessionBackButton">
          <Link to="/issues">← 看板</Link>
        </Button>
        <div className="sessionMobileTitle">
          <div className="sessionMobileTitleText">{issue?.title ?? "—"}</div>
        </div>
        <div className="sessionMobileMenu" ref={menuRef}>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="sessionMenuButton"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="更多"
            aria-expanded={menuOpen}
          >
            ⋯
          </Button>
          {menuOpen ? (
            <div className="sessionMobileMenuPanel">
              <div className="sessionMobileMenuMeta">
                <div className="muted">
                  WS: {ws.status}
                  {refreshing ? " · 同步中…" : ""}
                </div>
                {status ? <StatusBadge status={status as any} /> : <span className="muted">-</span>}
                <ThemeToggle />
              </div>
              <SessionSidebarContent
                model={props.model}
                showBackLink={false}
                onNavigate={() => setMenuOpen(false)}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
