import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { approveApproval, listApprovals, rejectApproval } from "../../api/approvals";
import { listIssues } from "../../api/issues";
import { listProjects } from "../../api/projects";
import { useAuth } from "../../auth/AuthContext";
import { ThemeToggle } from "../../components/ThemeToggle";
import type { Approval, Project } from "../../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    () => getSectionFromSearch(location.search) ?? "projects",
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

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
      setSelectedProjectId((prev) => (prev ? prev : (ps[0]?.id ?? "")));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (auth.status === "loading") return;
    void refresh();
  }, [auth.status, refresh]);

  useEffect(() => {
    const fromUrl = getSectionFromSearch(location.search);
    if (!fromUrl) return;
    setActiveSection((prev) => (prev === fromUrl ? prev : fromUrl));
  }, [location.search]);

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
            <select
              aria-label="选择 Project"
              value={effectiveProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
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
          <button
            type="button"
            className={`adminNavItem ${activeSection === "acpSessions" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("acpSessions")}
          >
            <span>ACP Proxies</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "approvals" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("approvals")}
          >
            <span>审批队列</span>
            {approvals.length ? (
              <Badge className="bg-warning text-warning-foreground hover:bg-warning/80">
                {approvals.length}
              </Badge>
            ) : null}
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "settings" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("settings")}
          >
            <span>平台设置</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "policy" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("policy")}
          >
            <span>策略</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "projects" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("projects")}
          >
            <span>项目管理</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "issues" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("issues")}
          >
            <span>Issue 管理</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "roles" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("roles")}
          >
            <span>角色模板</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "textTemplates" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("textTemplates")}
          >
            <span>文本模板</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "archive" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("archive")}
          >
            <span>Issue 归档</span>
          </button>
        </nav>
      </aside>

      <main className="adminMain">
        <div className="container">
          <div className="header">
            <div>
              <h1>{activeSectionMeta.title}</h1>
              <div className="muted">{activeSectionMeta.desc}</div>
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
