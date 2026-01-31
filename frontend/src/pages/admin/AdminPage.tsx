import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { approveApproval, listApprovals, rejectApproval } from "../../api/approvals";
import { listIssues } from "../../api/issues";
import { listProjects } from "../../api/projects";
import { useAuth } from "../../auth/AuthContext";
import { ThemeToggle } from "../../components/ThemeToggle";
import type { Approval, Project } from "../../types";
import { getLastSelectedProjectId, setLastSelectedProjectId } from "../../utils/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ADMIN_SECTION_META, getSectionFromSearch, type AdminSectionKey } from "./adminSections";
import { AcpSessionsSection } from "./sections/AcpSessionsSection";
import { ApprovalsSection } from "./sections/ApprovalsSection";
import { ArchiveSection } from "./sections/ArchiveSection";
import { IssuesSection } from "./sections/IssuesSection";
import { PolicySection } from "./sections/PolicySection";
import { ProjectsSection } from "./sections/ProjectsSection";
import { RolesSection } from "./sections/RolesSection";
import { SettingsSection } from "./sections/SettingsSection";
import { TextTemplatesSection } from "./sections/TextTemplatesSection";

export function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  const [projects, setProjects] = useState<Project[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<AdminSectionKey>(
    () => getSectionFromSearch(location.search) ?? "issues",
  );
  const [selectedProjectId, setSelectedProjectIdState] = useState<string>(() =>
    getLastSelectedProjectId(),
  );
  const selectedProjectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const setSelectedProjectId = useCallback((next: string) => {
    selectedProjectIdRef.current = next;
    setSelectedProjectIdState(next);
    setLastSelectedProjectId(next);
  }, []);

  const [acpSessionsReloadToken, setAcpSessionsReloadToken] = useState(0);
  const [acpSessionsLoading, setAcpSessionsLoading] = useState(false);
  const [textTemplatesReloadToken, setTextTemplatesReloadToken] = useState(0);
  const [textTemplatesLoading, setTextTemplatesLoading] = useState(false);

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

  const effectiveProject = useMemo(() => {
    return effectiveProjectId ? (projects.find((p) => p.id === effectiveProjectId) ?? null) : null;
  }, [effectiveProjectId, projects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ps, , aps] = await Promise.all([
        listProjects(),
        listIssues(),
        listApprovals({ status: "pending", limit: 100 }),
      ]);
      setProjects(ps);
      setApprovals(aps);
      const stored = getLastSelectedProjectId();
      const preferred = selectedProjectIdRef.current || stored;
      const next =
        preferred && ps.some((p) => p.id === preferred) ? preferred : (ps[0]?.id ?? "");
      setSelectedProjectId(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setSelectedProjectId]);

  useEffect(() => {
    if (auth.status === "loading") return;
    void refresh();
  }, [auth.status, refresh]);

  useEffect(() => {
    const fromUrl = getSectionFromSearch(location.search);
    if (!fromUrl) return;
    setActiveSection((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [location.search]);

  useEffect(() => {
    setError(null);
  }, [activeSection]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (ua.includes("jsdom")) return;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [activeSection]);

  const setActiveSectionWithUrl = useCallback(
    (next: AdminSectionKey) => {
      setActiveSection(next);
      const params = new URLSearchParams(location.search);
      params.set("section", next);
      navigate(`${location.pathname}?${params.toString()}`);
    },
    [location.pathname, location.search, navigate],
  );

  const requireAdmin = useCallback((): boolean => {
    if (!auth.user) {
      const next = encodeURIComponent(`${location.pathname}${location.search}`);
      navigate(`/login?next=${next}`);
      return false;
    }
    if (!auth.hasRole(["admin"])) {
      setError("需要管理员权限");
      return false;
    }
    return true;
  }, [auth, location.pathname, location.search, navigate]);

  const onApproveApproval = useCallback(
    async (id: string) => {
      setError(null);
      if (!requireAdmin()) return;
      setApprovalBusyId(id);
      try {
        await approveApproval(id, "admin");
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApprovalBusyId("");
      }
    },
    [refresh, requireAdmin],
  );

  const onRejectApproval = useCallback(
    async (id: string) => {
      setError(null);
      if (!requireAdmin()) return;
      setApprovalBusyId(id);
      try {
        await rejectApproval(id, { actor: "admin", reason: "rejected by admin" });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setApprovalBusyId("");
      }
    },
    [refresh, requireAdmin],
  );

  const onRefreshClick = useCallback(() => {
    if (activeSection === "acpSessions") {
      setAcpSessionsReloadToken((v) => v + 1);
      return;
    }
    if (activeSection === "textTemplates") {
      setTextTemplatesReloadToken((v) => v + 1);
      return;
    }
    void refresh();
  }, [activeSection, refresh]);

  const activeSectionMeta = ADMIN_SECTION_META[activeSection];

  const navGroups: Array<{ label: string; items: AdminSectionKey[] }> = [
    { label: "待办", items: ["approvals", "issues"] },
    { label: "运行", items: ["acpSessions"] },
    { label: "配置", items: ["projects", "roles", "policy", "textTemplates", "settings"] },
    { label: "归档", items: ["archive"] },
  ];

  return (
    <div className="adminShell">
      <aside className="adminSidebar">
        <div className="adminSidebarHeader">
          <div className="adminSidebarTitle">管理</div>
          <div className="muted">平台设置 / 项目配置 / 归档</div>
        </div>

        <div className="adminSidebarProject">
          <div className="muted" style={{ marginBottom: 6 }}>
            当前 Project
          </div>
          {loading ? (
            <div className="muted">加载中…</div>
          ) : projects.length ? (
            <Select value={effectiveProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger aria-label="选择 Project" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="muted">暂无 Project，请先创建</div>
          )}
          {effectiveProject ? (
            <div className="adminSidebarProjectMeta">
              <div className="adminSidebarProjectRow">
                <div className="muted">Repo</div>
                <code>{effectiveProject.repoUrl}</code>
              </div>
              <div className="adminSidebarProjectRow">
                <div className="muted">SCM</div>
                <code>{effectiveProject.scmType}</code>
              </div>
              <div className="adminSidebarProjectRow">
                <div className="muted">默认分支</div>
                <code>{effectiveProject.defaultBranch}</code>
              </div>
            </div>
          ) : null}
        </div>

        <nav className="adminNav" aria-label="管理菜单">
          {navGroups.map((group) => (
            <div key={group.label} className="adminNavGroup">
              <div className="adminNavGroupLabel">{group.label}</div>
              <div className="adminNavGroupItems">
                {group.items.map((key) => {
                  const meta = ADMIN_SECTION_META[key];
                  const label = meta.nav ?? meta.title;
                  const isActive = activeSection === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`adminNavItem ${isActive ? "active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => setActiveSectionWithUrl(key)}
                      title={meta.desc}
                    >
                      <span>{label}</span>
                      {key === "approvals" && approvals.length ? (
                        <Badge className="bg-warning text-warning-foreground hover:bg-warning/80">
                          {approvals.length}
                        </Badge>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main className="adminMain">
        <div className="container">
          <div className="header">
            <div>
              <h1>{activeSectionMeta.title}</h1>
              <div className="muted">
                {activeSectionMeta.desc}
                {effectiveProject ? (
                  <>
                    {" · "}Project: <code>{effectiveProject.name}</code>
                  </>
                ) : effectiveProjectId ? (
                  <>
                    {" · "}projectId: <code>{effectiveProjectId}</code>
                  </>
                ) : null}
              </div>
            </div>
            <div className="row gap">
              <Button variant="link" size="sm" asChild>
                <Link to="/issues">← 返回看板</Link>
              </Button>
              <ThemeToggle />
              {auth.user ? (
                <span className="muted" title={auth.user.id}>
                  {auth.user.username} ({auth.user.role})
                </span>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    navigate(
                      `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
                    )
                  }
                >
                  登录
                </Button>
              )}
              {auth.user ? (
                <Button type="button" variant="secondary" size="sm" onClick={() => auth.logout()}>
                  退出
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefreshClick}
                disabled={
                  activeSection === "acpSessions"
                    ? acpSessionsLoading
                    : activeSection === "textTemplates"
                      ? textTemplatesLoading
                      : loading
                }
              >
                刷新
              </Button>
            </div>
          </div>

          {error ? (
            <div role="alert" className="alert">
              {error}
            </div>
          ) : null}

          <ApprovalsSection
            active={activeSection === "approvals"}
            approvals={approvals}
            loading={loading}
            busyId={approvalBusyId}
            onApprove={onApproveApproval}
            onReject={onRejectApproval}
          />

          <SettingsSection active={activeSection === "settings"} />

          <AcpSessionsSection
            active={activeSection === "acpSessions"}
            effectiveProjectId={effectiveProjectId}
            reloadToken={acpSessionsReloadToken}
            requireAdmin={requireAdmin}
            setError={setError}
            onLoadingChange={setAcpSessionsLoading}
          />

          <PolicySection
            active={activeSection === "policy"}
            effectiveProjectId={effectiveProjectId}
            effectiveProject={effectiveProject}
            requireAdmin={requireAdmin}
            setError={setError}
          />

          <TextTemplatesSection
            active={activeSection === "textTemplates"}
            effectiveProjectId={effectiveProjectId}
            effectiveProject={effectiveProject}
            reloadToken={textTemplatesReloadToken}
            requireAdmin={requireAdmin}
            setError={setError}
            onLoadingChange={setTextTemplatesLoading}
          />

          <div
            className="grid2"
            hidden={
              activeSection === "approvals" ||
              activeSection === "settings" ||
              activeSection === "acpSessions" ||
              activeSection === "policy" ||
              activeSection === "textTemplates"
            }
          >
            <ProjectsSection
              active={activeSection === "projects"}
              loading={loading}
              projects={projects}
              effectiveProject={effectiveProject}
              effectiveProjectId={effectiveProjectId}
              requireAdmin={requireAdmin}
              setError={setError}
              onRefreshGlobal={refresh}
              onSelectedProjectIdChange={setSelectedProjectId}
            />

            <IssuesSection
              active={activeSection === "issues"}
              effectiveProject={effectiveProject}
              effectiveProjectId={effectiveProjectId}
              requireAdmin={requireAdmin}
              setError={setError}
              onRefreshGlobal={refresh}
            />

            <RolesSection
              active={activeSection === "roles"}
              effectiveProjectId={effectiveProjectId}
              requireAdmin={requireAdmin}
              setError={setError}
            />

            <ArchiveSection
              active={activeSection === "archive"}
              effectiveProjectId={effectiveProjectId}
              requireAdmin={requireAdmin}
              setError={setError}
              onRefreshGlobal={refresh}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
