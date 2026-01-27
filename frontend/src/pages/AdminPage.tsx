import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { approveApproval, listApprovals, rejectApproval } from "../api/approvals";
import { cancelAcpSession, listAcpSessions } from "../api/acpSessions";
import { createIssue, listIssues, updateIssue } from "../api/issues";
import { importGitHubIssue } from "../api/githubIssues";
import { getPmPolicy, updatePmPolicy } from "../api/policies";
import { createProject, listProjects } from "../api/projects";
import { createRole } from "../api/roles";
import { useAuth } from "../auth/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import type { AcpSessionSummary, Approval, Issue, IssueStatus, PmPolicy, Project } from "../types";
import { getShowArchivedIssues, setShowArchivedIssues } from "../utils/settings";

const ADMIN_SECTION_KEYS = ["acpSessions", "approvals", "settings", "policy", "projects", "issues", "roles", "archive"] as const;
type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

const ARCHIVE_STATUSES: IssueStatus[] = ["done", "failed", "cancelled"];
type ArchiveStatusFilter = "all" | "done" | "failed" | "cancelled";
type ArchiveArchivedFilter = "all" | "archived" | "unarchived";

function getSectionFromSearch(search: string): AdminSectionKey | null {
  const raw = new URLSearchParams(search).get("section");
  if (!raw) return null;
  return (ADMIN_SECTION_KEYS as readonly string[]).includes(raw) ? (raw as AdminSectionKey) : null;
}

function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [, setIssues] = useState<Issue[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<AdminSectionKey>(() => getSectionFromSearch(location.search) ?? "projects");

  const [acpSessions, setAcpSessions] = useState<AcpSessionSummary[]>([]);
  const [loadingAcpSessions, setLoadingAcpSessions] = useState(false);
  const [cancelingAcpSessionKey, setCancelingAcpSessionKey] = useState<string>("");

  const [showArchivedOnBoard, setShowArchivedOnBoard] = useState<boolean>(() => getShowArchivedIssues());
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [policyText, setPolicyText] = useState<string>("");
  const [policySource, setPolicySource] = useState<"project" | "default" | "">("");
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [projectScmType, setProjectScmType] = useState("gitlab");
  const [projectDefaultBranch, setProjectDefaultBranch] = useState("main");
  const [projectWorkspaceMode, setProjectWorkspaceMode] = useState<"worktree" | "clone">("worktree");
  const [projectGitAuthMode, setProjectGitAuthMode] = useState<"https_pat" | "ssh">("https_pat");
  const [projectGitlabProjectId, setProjectGitlabProjectId] = useState("");
  const [projectGitlabAccessToken, setProjectGitlabAccessToken] = useState("");
  const [projectGitlabWebhookSecret, setProjectGitlabWebhookSecret] = useState("");
  const [projectGithubAccessToken, setProjectGithubAccessToken] = useState("");

  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueCriteria, setIssueCriteria] = useState("");

  const [githubImport, setGithubImport] = useState("");
  const [importingGithub, setImportingGithub] = useState(false);

  const [roleKey, setRoleKey] = useState("");
  const [roleDisplayName, setRoleDisplayName] = useState("");
  const [rolePromptTemplate, setRolePromptTemplate] = useState("");
  const [roleInitScript, setRoleInitScript] = useState("");
  const [roleInitTimeoutSeconds, setRoleInitTimeoutSeconds] = useState("300");

  const [archiveItems, setArchiveItems] = useState<Issue[]>([]);
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [archiveLimit, setArchiveLimit] = useState(20);
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveStatusFilter>("all");
  const [archiveArchived, setArchiveArchived] = useState<ArchiveArchivedFilter>("all");
  const [archiveQueryDraft, setArchiveQueryDraft] = useState("");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveBusyId, setArchiveBusyId] = useState("");
  const [archiveReloadToken, setArchiveReloadToken] = useState(0);

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

  const effectiveProject = useMemo(() => {
    return effectiveProjectId ? projects.find((p) => p.id === effectiveProjectId) ?? null : null;
  }, [effectiveProjectId, projects]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [ps, is, aps] = await Promise.all([listProjects(), listIssues(), listApprovals({ status: "pending", limit: 100 })]);
      setProjects(ps);
      setIssues(is.issues);
      setApprovals(aps);
      if (!selectedProjectId && ps[0]?.id) setSelectedProjectId(ps[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshAcpSessions() {
    setLoadingAcpSessions(true);
    setError(null);
    try {
      const rows = await listAcpSessions({
        projectId: effectiveProjectId ? effectiveProjectId : undefined,
        limit: 200,
      });
      setAcpSessions(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAcpSessions(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSection !== "acpSessions") return;
    void refreshAcpSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, effectiveProjectId]);

  useEffect(() => {
    if (activeSection !== "policy") return;
    if (!effectiveProjectId) return;

    setPolicyLoading(true);
    setError(null);
    void (async () => {
      try {
        const { policy, source } = await getPmPolicy(effectiveProjectId);
        setPolicySource(source);
        setPolicyText(JSON.stringify(policy, null, 2));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPolicyLoading(false);
      }
    })();
  }, [activeSection, effectiveProjectId]);

  useEffect(() => {
    const fromUrl = getSectionFromSearch(location.search);
    if (fromUrl && fromUrl !== activeSection) setActiveSection(fromUrl);
  }, [activeSection, location.search]);

  useEffect(() => {
    if (activeSection !== "issues") return;
    const hash = location.hash || "";
    const id = hash.startsWith("#") ? hash.slice(1) : "";
    if (!id) return;

    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
    return () => clearTimeout(t);
  }, [activeSection, location.hash]);

  useEffect(() => {
    if (activeSection !== "archive") return;
    setArchiveOffset(0);
  }, [activeSection, effectiveProjectId]);

  useEffect(() => {
    if (activeSection !== "archive") return;
    if (!effectiveProjectId) return;

    const statuses: IssueStatus[] = archiveStatus === "all" ? ARCHIVE_STATUSES : [archiveStatus];
    const archivedFlag = archiveArchived === "all" ? undefined : archiveArchived === "archived";

    let cancelled = false;
    setArchiveLoading(true);
    setArchiveError(null);
    void listIssues({
      projectId: effectiveProjectId,
      statuses,
      archived: archivedFlag,
      q: archiveQuery.trim() ? archiveQuery.trim() : undefined,
      limit: archiveLimit,
      offset: archiveOffset
    })
      .then((res) => {
        if (cancelled) return;
        setArchiveItems(res.issues);
        setArchiveTotal(res.total);
      })
      .catch((err) => {
        if (cancelled) return;
        setArchiveError(err instanceof Error ? err.message : String(err));
        setArchiveItems([]);
        setArchiveTotal(0);
      })
      .finally(() => {
        if (cancelled) return;
        setArchiveLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeSection, archiveArchived, archiveLimit, archiveOffset, archiveQuery, archiveReloadToken, archiveStatus, effectiveProjectId]);

  function setActiveSectionWithUrl(next: AdminSectionKey) {
    setActiveSection(next);
    const params = new URLSearchParams(location.search);
    params.set("section", next);
    navigate(`${location.pathname}?${params.toString()}`);
  }
  function requireAdmin(): boolean {
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
  }

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
    try {
      const gitlabProjectIdRaw = projectGitlabProjectId.trim();
      const gitlabProjectId = gitlabProjectIdRaw ? Number(gitlabProjectIdRaw) : undefined;

      const p = await createProject({
        name: projectName.trim(),
        repoUrl: projectRepoUrl.trim(),
        scmType: projectScmType.trim() || undefined,
        defaultBranch: projectDefaultBranch.trim() || undefined,
        workspaceMode: projectWorkspaceMode,
        gitAuthMode: projectGitAuthMode,
        gitlabProjectId: Number.isFinite(gitlabProjectId ?? NaN) ? gitlabProjectId : undefined,
        gitlabAccessToken: projectGitlabAccessToken.trim() || undefined,
        gitlabWebhookSecret: projectGitlabWebhookSecret.trim() || undefined,
        githubAccessToken: projectGithubAccessToken.trim() || undefined
      });
      setProjectName("");
      setProjectRepoUrl("");
      setProjectScmType("gitlab");
      setProjectDefaultBranch("main");
      setProjectWorkspaceMode("worktree");
      setProjectGitAuthMode("https_pat");
      setProjectGitlabProjectId("");
      setProjectGitlabAccessToken("");
      setProjectGitlabWebhookSecret("");
      setProjectGithubAccessToken("");
      await refresh();
      setSelectedProjectId(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateIssue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
    try {
      if (!issueTitle.trim()) {
        setError("Issue 标题不能为空");
        return;
      }
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }

      await createIssue({
        projectId: effectiveProjectId,
        title: issueTitle.trim(),
        description: issueDescription.trim() ? issueDescription.trim() : undefined,
        acceptanceCriteria: splitLines(issueCriteria),
      });

      setIssueTitle("");
      setIssueDescription("");
      setIssueCriteria("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImportGithubIssue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先创建 Project");
      return;
    }
    const raw = githubImport.trim();
    if (!raw) return;

    setImportingGithub(true);
    try {
      const num = Number(raw);
      const input = Number.isFinite(num) && num > 0 ? { number: Math.floor(num) } : { url: raw };
      await importGitHubIssue(effectiveProjectId, input);
      setGithubImport("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingGithub(false);
    }
  }

  async function onCreateRole(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先创建 Project");
      return;
    }

    const key = roleKey.trim();
    const name = roleDisplayName.trim();
    if (!key || !name) return;

    try {
      await createRole(effectiveProjectId, {
        key,
        displayName: name,
        promptTemplate: rolePromptTemplate.trim() || undefined,
        initScript: roleInitScript.trim() || undefined,
        initTimeoutSeconds: Number(roleInitTimeoutSeconds) || undefined
      });
      setRoleKey("");
      setRoleDisplayName("");
      setRolePromptTemplate("");
      setRoleInitScript("");
      setRoleInitTimeoutSeconds("300");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onToggleArchived(issue: Issue) {
    setError(null);
    if (!requireAdmin()) return;
    setArchiveBusyId(issue.id);
    try {
      const next = !issue.archivedAt;
      await updateIssue(issue.id, { archived: next });
      await refresh();
      if (activeSection === "archive") {
        setArchiveReloadToken((v) => v + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiveBusyId("");
    }
  }

  async function onApproveApproval(id: string) {
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
  }

  async function onRejectApproval(id: string) {
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
  }

  async function onCancelAcpSession(runId: string, sessionId: string) {
    setError(null);
    if (!requireAdmin()) return;
    if (!window.confirm(`确认关闭 ACP session？\n\nrunId: ${runId}\nsessionId: ${sessionId}`)) return;

    const key = `${runId}:${sessionId}`;
    setCancelingAcpSessionKey(key);
    try {
      await cancelAcpSession(runId, sessionId);
      await refreshAcpSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelingAcpSessionKey("");
    }
  }

  function onShowArchivedOnBoardChange(next: boolean) {
    setShowArchivedOnBoard(next);
    setShowArchivedIssues(next);
  }

  const activeSectionMeta = useMemo(() => {
    const meta: Record<AdminSectionKey, { title: string; desc: string }> = {
      approvals: { title: "审批队列", desc: "Pending approvals / 需要人工确认的动作" },
      settings: { title: "平台设置", desc: "影响看板展示与全局行为" },
      policy: { title: "策略（Policy）", desc: "Project 级：自动化开关 / 审批门禁 / 敏感目录（JSON）" },
      projects: { title: "项目管理", desc: "创建/配置 Project（仓库、SCM、认证方式等）" },
      issues: { title: "Issue 管理", desc: "创建需求或导入外部 Issue" },
      roles: { title: "角色模板", desc: "创建 RoleTemplate（Prompt / initScript 等）" },
      archive: { title: "Issue 归档", desc: "管理已完成/失败/取消的 Issue 归档状态" },
      acpSessions: { title: "ACP Sessions", desc: "查看/手动关闭 ACP agent session（用于清理遗留会话）" }
    };
    return meta[activeSection];
  }, [activeSection]);

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
            <span>ACP Sessions</span>
          </button>
          <button
            type="button"
            className={`adminNavItem ${activeSection === "approvals" ? "active" : ""}`}
            onClick={() => setActiveSectionWithUrl("approvals")}
          >
            <span>审批队列</span>
            {approvals.length ? <span className="badge orange">{approvals.length}</span> : null}
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
          <Link to="/issues">← 返回看板</Link>
          <ThemeToggle />
          {auth.user ? (
            <span className="muted" title={auth.user.id}>
              {auth.user.username} ({auth.user.role})
            </span>
          ) : (
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => navigate(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`)}
            >
              登录
            </button>
          )}
          {auth.user ? (
            <button type="button" className="buttonSecondary" onClick={() => auth.logout()}>
              退出
            </button>
          ) : null}
          <button
            onClick={() => (activeSection === "acpSessions" ? refreshAcpSessions() : refresh())}
            disabled={activeSection === "acpSessions" ? loadingAcpSessions : loading}
          >
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <section className="card" style={{ marginBottom: 16 }} hidden={activeSection !== "approvals"}>
        <h2 style={{ marginTop: 0 }}>审批队列</h2>
        {approvals.length ? (
          <ul className="list">
            {approvals.map((a) => (
              <li key={a.id} className="listItem">
                <div className="row spaceBetween">
                  <div>
                    <code>{a.action}</code>
                    <span className="muted" style={{ marginLeft: 10 }}>
                      {a.issueTitle ?? a.issueId ?? a.runId}
                    </span>
                  </div>
                  <div className="row gap">
                    <Link to={a.issueId ? `/issues/${a.issueId}` : "/issues"}>打开</Link>
                    <button onClick={() => onApproveApproval(a.id)} disabled={loading || approvalBusyId === a.id}>
                      批准
                    </button>
                    <button onClick={() => onRejectApproval(a.id)} disabled={loading || approvalBusyId === a.id}>
                      拒绝
                    </button>
                  </div>
                </div>
                <div className="muted" style={{ marginTop: 6 }}>
                  状态：{a.status}
                  {a.requestedBy ? ` · 请求人：${a.requestedBy}` : ""}
                  {a.requestedAt ? ` · 请求时间：${new Date(a.requestedAt).toLocaleString()}` : ""}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted">暂无待审批动作</div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }} hidden={activeSection !== "settings"}>
        <h2 style={{ marginTop: 0 }}>平台设置</h2>
        <label className="row gap">
          <input
            type="checkbox"
            checked={showArchivedOnBoard}
            onChange={(e) => onShowArchivedOnBoardChange(e.target.checked)}
          />
          <span>主界面显示已归档 Issue</span>
        </label>
        <div className="muted" style={{ marginTop: 8 }}>
          关闭时：归档的 Issue 默认不在看板显示；打开后会在对应状态列中显示。
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }} hidden={activeSection !== "acpSessions"}>
        <h2 style={{ marginTop: 0 }}>ACP Sessions</h2>
        <div className="muted">
          列出当前项目下已建立的 ACP session（来自 Run.acpSessionId），可手动发送 <code>session/cancel</code> 关闭遗留会话。
        </div>

        {loadingAcpSessions ? (
          <div className="muted" style={{ marginTop: 12 }}>
            加载中…
          </div>
        ) : acpSessions.length ? (
          <div className="tableScroll">
            <table className="table">
              <thead>
                <tr>
                  <th>sessionId</th>
                  <th>Agent</th>
                  <th>Session 状态</th>
                  <th>Run 状态</th>
                  <th>Issue</th>
                  <th>Run</th>
                  <th>开始时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {acpSessions.map((s) => {
                  const key = `${s.runId}:${s.sessionId}`;
                  const busy = cancelingAcpSessionKey === key;
                  return (
                    <tr key={key}>
                      <td>
                        <code title={s.sessionId}>{s.sessionId}</code>
                      </td>
                      <td>
                        {s.agent ? (
                          <span className="row gap" style={{ alignItems: "center" }}>
                            <span title={s.agent.proxyId}>{s.agent.name}</span>
                            <StatusBadge status={s.agent.status} />
                          </span>
                        ) : (
                          <span className="muted">未绑定</span>
                        )}
                      </td>
                      <td>
                        {s.sessionState ? (
                          <div>
                            <span className="row gap" style={{ alignItems: "center" }}>
                              <StatusBadge status={s.sessionState.activity} />
                              {s.sessionState.inFlight ? (
                                <span className="muted">inFlight={s.sessionState.inFlight}</span>
                              ) : null}
                            </span>
                            <div className="muted" style={{ marginTop: 4 }}>
                              {s.sessionState.currentModeId ? (
                                <>
                                  mode: <code>{s.sessionState.currentModeId}</code>
                                </>
                              ) : (
                                "mode: -"
                              )}
                              {s.sessionState.lastStopReason ? ` · stop: ${s.sessionState.lastStopReason}` : ""}
                              {s.sessionState.updatedAt ? ` · ${new Date(s.sessionState.updatedAt).toLocaleString()}` : ""}
                            </div>
                          </div>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={s.runStatus} />
                      </td>
                      <td>
                        <Link to={`/issues/${s.issueId}`}>{s.issueTitle || s.issueId}</Link>
                      </td>
                      <td>
                        <code title={s.runId}>{s.runId.slice(0, 8)}…</code>
                      </td>
                      <td className="muted">{new Date(s.startedAt).toLocaleString()}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="buttonSecondary"
                          onClick={() => onCancelAcpSession(s.runId, s.sessionId)}
                          disabled={busy || !s.agent}
                          title={!s.agent ? "该 Run 未绑定 Agent（无法下发 session/cancel）" : ""}
                        >
                          {busy ? "关闭中…" : "关闭"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 12 }}>
            暂无 ACP session
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }} hidden={activeSection !== "policy"}>
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>策略（Policy）</h2>
            <div className="muted">
              {effectiveProject ? (
                <>
                  Project: <code>{effectiveProject.name}</code>
                  {policySource ? ` · source: ${policySource}` : ""}
                </>
              ) : (
                "请先创建/选择 Project"
              )}
            </div>
          </div>
          <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() =>
                setPolicyText(
                  JSON.stringify(
                    {
                      version: 1,
                      automation: {
                        autoStartIssue: true,
                        autoReview: true,
                        autoCreatePr: true,
                        autoRequestMergeApproval: true,
                      },
                      approvals: { requireForActions: ["merge_pr"] },
                      sensitivePaths: [],
                    } satisfies PmPolicy,
                    null,
                    2,
                  ),
                )
              }
              disabled={!effectiveProjectId || policyLoading || policySaving}
            >
              载入默认
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!effectiveProjectId) return;
                if (!requireAdmin()) return;
                setPolicySaving(true);
                setError(null);
                try {
                  const parsed = JSON.parse(policyText || "{}") as PmPolicy;
                  const res = await updatePmPolicy(effectiveProjectId, parsed);
                  setPolicySource("project");
                  setPolicyText(JSON.stringify(res.policy, null, 2));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setPolicySaving(false);
                }
              }}
              disabled={!effectiveProjectId || policyLoading || policySaving}
            >
              {policySaving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>

        {policyLoading ? (
          <div className="muted" style={{ marginTop: 10 }}>
            加载中…
          </div>
        ) : (
          <textarea
            value={policyText}
            onChange={(e) => setPolicyText(e.target.value)}
            rows={14}
            className="inputMono"
            style={{ width: "100%", marginTop: 10 }}
            placeholder='{"version":1,"automation":{"autoStartIssue":true,"autoReview":true,"autoCreatePr":true,"autoRequestMergeApproval":true},"approvals":{"requireForActions":["merge_pr"]},"sensitivePaths":[] }'
          />
        )}

        <div className="muted" style={{ marginTop: 8 }}>
          后端接口：<code>GET/PUT /api/policies?projectId=...</code>（存储在 <code>Project.branchProtection.pmPolicy</code>）。
        </div>
      </section>

      <div
        className="grid2"
        hidden={
          activeSection === "approvals" ||
          activeSection === "settings" ||
          activeSection === "acpSessions" ||
          activeSection === "policy"
        }
      >
        <section className="card" hidden={activeSection !== "projects"}>
          <h2 style={{ marginTop: 0 }}>当前 Project</h2>

          {loading ? (
            <div className="muted">加载中…</div>
          ) : effectiveProject ? (
            <div className="kvGrid" style={{ marginTop: 12 }}>
              <div className="kvItem">
                <div className="muted">Repo</div>
                <code>{effectiveProject.repoUrl}</code>
              </div>
              <div className="kvItem">
                <div className="muted">SCM</div>
                <code>{effectiveProject.scmType}</code>
              </div>
              <div className="kvItem">
                <div className="muted">默认分支</div>
                <code>{effectiveProject.defaultBranch}</code>
              </div>
            </div>
          ) : (
            <div className="muted">暂无 Project，请先创建</div>
          )}
        </section>

        <section className="card" hidden={activeSection !== "projects"}>
          <h2 style={{ marginTop: 0 }}>Projects</h2>
          {loading ? (
            <div className="muted">加载中…</div>
          ) : projects.length ? (
            <div className="muted">当前共 {projects.length} 个</div>
          ) : (
            <div className="muted">暂无 Project，请先创建</div>
          )}

          <form onSubmit={onCreateProject} className="form">
            <label className="label">
              名称
              <input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            </label>
            <label className="label">
              Repo URL
              <input value={projectRepoUrl} onChange={(e) => setProjectRepoUrl(e.target.value)} />
            </label>
            <label className="label">
              SCM
              <select value={projectScmType} onChange={(e) => setProjectScmType(e.target.value)}>
                <option value="gitlab">gitlab</option>
                <option value="github">github</option>
                <option value="gitee">gitee</option>
              </select>
            </label>
            <label className="label">
              默认分支
              <input value={projectDefaultBranch} onChange={(e) => setProjectDefaultBranch(e.target.value)} />
            </label>
            <label className="label">
              工作区模式
              <select
                value={projectWorkspaceMode}
                onChange={(e) => setProjectWorkspaceMode(e.target.value as "worktree" | "clone")}
              >
                <option value="worktree">worktree（本机仓库）</option>
                <option value="clone">clone（Run 全量 clone）</option>
              </select>
            </label>
            <label className="label">
              Git 认证
              <select
                value={projectGitAuthMode}
                onChange={(e) => setProjectGitAuthMode(e.target.value as "https_pat" | "ssh")}
              >
                <option value="https_pat">https_pat（token）</option>
                <option value="ssh">ssh</option>
              </select>
            </label>
            {projectScmType === "gitlab" ? (
              <details>
                <summary>GitLab 配置（可选）</summary>
                <label className="label">
                  GitLab Project ID
                  <input
                    value={projectGitlabProjectId}
                    onChange={(e) => setProjectGitlabProjectId(e.target.value)}
                    placeholder="12345"
                  />
                </label>
                <label className="label">
                  GitLab Access Token
                  <input
                    type="password"
                    value={projectGitlabAccessToken}
                    onChange={(e) => setProjectGitlabAccessToken(e.target.value)}
                    placeholder="glpat-..."
                  />
                </label>
                <label className="label">
                  GitLab Webhook Secret（可选）
                  <input
                    type="password"
                    value={projectGitlabWebhookSecret}
                    onChange={(e) => setProjectGitlabWebhookSecret(e.target.value)}
                  />
                </label>
              </details>
            ) : projectScmType === "github" ? (
              <details>
                <summary>GitHub 配置（可选）</summary>
                <label className="label">
                  GitHub Access Token
                  <input
                    type="password"
                    value={projectGithubAccessToken}
                    onChange={(e) => setProjectGithubAccessToken(e.target.value)}
                    placeholder="ghp_... / github_pat_..."
                  />
                </label>
              </details>
            ) : null}
            <button type="submit" disabled={!projectName.trim() || !projectRepoUrl.trim()}>
              创建
            </button>
          </form>
        </section>

        <section
          id="issue-github-import"
          className="card"
          style={{ gridColumn: "1 / -1" }}
          hidden={activeSection !== "issues"}
        >
          <h2 style={{ marginTop: 0 }}>导入 GitHub Issue</h2>
          {effectiveProject?.scmType?.toLowerCase() === "github" ? (
            <form onSubmit={onImportGithubIssue} className="form">
              <label className="label">
                Issue Number 或 URL
                <input
                  value={githubImport}
                  onChange={(e) => setGithubImport(e.target.value)}
                  placeholder="123 或 https://github.com/o/r/issues/123"
                />
              </label>
              <button type="submit" disabled={!githubImport.trim() || importingGithub || !effectiveProjectId}>
                {importingGithub ? "导入中…" : "导入"}
              </button>
            </form>
          ) : (
            <div className="muted">当前 Project 不是 GitHub SCM</div>
          )}
        </section>

        <section
          id="issue-create"
          className="card"
          style={{ gridColumn: "1 / -1" }}
          hidden={activeSection !== "issues"}
        >
          <h2 style={{ marginTop: 0 }}>创建 Issue（进入需求池）</h2>
          <form onSubmit={onCreateIssue} className="form">
            <label className="label">
              标题 *
              <input
                aria-label="Issue 标题"
                value={issueTitle}
                onChange={(e) => setIssueTitle(e.target.value)}
              />
            </label>
            <label className="label">
              描述
              <textarea value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} />
            </label>
            <label className="label">
              验收标准（每行一条）
              <textarea value={issueCriteria} onChange={(e) => setIssueCriteria(e.target.value)} />
            </label>
            <button type="submit" disabled={!effectiveProjectId}>
              提交
            </button>
          </form>
          {!effectiveProjectId ? <div className="muted">请先创建 Project</div> : null}
        </section>

        <section className="card" hidden={activeSection !== "roles"}>
          <h2 style={{ marginTop: 0 }}>创建 RoleTemplate</h2>
          <form onSubmit={onCreateRole} className="form">
            <label className="label">
              Role Key *
              <input value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="backend-dev" />
            </label>
            <label className="label">
              显示名称 *
              <input
                value={roleDisplayName}
                onChange={(e) => setRoleDisplayName(e.target.value)}
                placeholder="后端开发"
              />
            </label>
            <label className="label">
              Prompt Template（可选）
              <textarea
                value={rolePromptTemplate}
                onChange={(e) => setRolePromptTemplate(e.target.value)}
                placeholder="你是 {{role.name}}，请优先写单测。"
              />
            </label>
            <label className="label">
              initScript（bash，可选）
              <textarea
                value={roleInitScript}
                onChange={(e) => setRoleInitScript(e.target.value)}
                placeholder={"# 可使用环境变量：GH_TOKEN/TUIXIU_WORKSPACE 等\n\necho init"}
              />
            </label>
            <label className="label">
              init 超时秒数（可选）
              <input
                value={roleInitTimeoutSeconds}
                onChange={(e) => setRoleInitTimeoutSeconds(e.target.value)}
                placeholder="300"
              />
            </label>
            <button type="submit" disabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}>
              创建
            </button>
          </form>
          {!effectiveProjectId ? <div className="muted">请先创建 Project</div> : null}
          <div className="muted" style={{ marginTop: 8 }}>
            initScript 默认在 workspace 执行；建议把持久内容写到 <code>$HOME/.tuixiu/projects/&lt;projectId&gt;</code>。
          </div>
        </section>

        <section className="card" hidden={activeSection !== "archive"}>
          <div className="row spaceBetween" style={{ alignItems: "baseline" }}>
            <div>
              <h2 style={{ marginTop: 0 }}>Issue 归档</h2>
              <div className="muted">已完成/失败/取消的 Issue（支持筛选与分页）</div>
            </div>
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => setArchiveReloadToken((v) => v + 1)}
              disabled={!effectiveProjectId || archiveLoading}
            >
              刷新
            </button>
          </div>

          {!effectiveProjectId ? (
            <div className="muted">请先创建 Project</div>
          ) : (
            <>
              <div className="row gap" style={{ alignItems: "flex-end", flexWrap: "wrap", marginTop: 10 }}>
                <label className="label" style={{ margin: 0, flex: "1 1 260px", minWidth: 220 }}>
                  关键词
                  <input
                    value={archiveQueryDraft}
                    onChange={(e) => setArchiveQueryDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      setArchiveOffset(0);
                      setArchiveQuery(archiveQueryDraft.trim());
                    }}
                    placeholder="标题关键字…"
                  />
                </label>

                <label className="label" style={{ margin: 0 }}>
                  状态
                  <select
                    value={archiveStatus}
                    onChange={(e) => {
                      setArchiveOffset(0);
                      setArchiveStatus(e.target.value as ArchiveStatusFilter);
                    }}
                  >
                    <option value="all">全部（done/failed/cancelled）</option>
                    <option value="done">done</option>
                    <option value="failed">failed</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>

                <label className="label" style={{ margin: 0 }}>
                  归档
                  <select
                    value={archiveArchived}
                    onChange={(e) => {
                      setArchiveOffset(0);
                      setArchiveArchived(e.target.value as ArchiveArchivedFilter);
                    }}
                  >
                    <option value="all">全部</option>
                    <option value="unarchived">未归档</option>
                    <option value="archived">已归档</option>
                  </select>
                </label>

                <label className="label" style={{ margin: 0 }}>
                  每页
                  <select
                    value={String(archiveLimit)}
                    onChange={(e) => {
                      setArchiveOffset(0);
                      setArchiveLimit(Number(e.target.value) || 20);
                    }}
                  >
                    <option value="20">20</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                  </select>
                </label>

                <div className="row gap">
                  <button
                    type="button"
                    onClick={() => {
                      setArchiveOffset(0);
                      setArchiveQuery(archiveQueryDraft.trim());
                    }}
                    disabled={archiveLoading}
                  >
                    筛选
                  </button>
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => {
                      setArchiveOffset(0);
                      setArchiveLimit(20);
                      setArchiveStatus("all");
                      setArchiveArchived("all");
                      setArchiveQueryDraft("");
                      setArchiveQuery("");
                    }}
                    disabled={archiveLoading}
                  >
                    重置
                  </button>
                </div>
              </div>

              {archiveError ? (
                <div className="muted" style={{ marginTop: 10 }} title={archiveError}>
                  归档列表加载失败：{archiveError}
                </div>
              ) : null}

              <div className="row spaceBetween" style={{ marginTop: 10 }}>
                <div className="muted">
                  {archiveLoading ? "加载中…" : `共 ${archiveTotal} 条`}
                </div>
                <div className="row gap">
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => setArchiveOffset((v) => Math.max(0, v - archiveLimit))}
                    disabled={archiveLoading || archiveOffset === 0}
                  >
                    上一页
                  </button>
                  <span className="muted">
                    {archiveTotal
                      ? `第 ${Math.floor(archiveOffset / archiveLimit) + 1} / ${Math.max(1, Math.ceil(archiveTotal / archiveLimit))} 页`
                      : "—"}
                  </span>
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => setArchiveOffset((v) => v + archiveLimit)}
                    disabled={archiveLoading || archiveOffset + archiveLimit >= archiveTotal}
                  >
                    下一页
                  </button>
                </div>
              </div>

              {archiveItems.length ? (
                <div className="tableScroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>标题</th>
                        <th>外部</th>
                        <th>状态</th>
                        <th>Run</th>
                        <th>创建时间</th>
                        <th>更新时间</th>
                        <th>归档时间</th>
                        <th style={{ textAlign: "right" }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {archiveItems.map((i) => {
                        const latestRun = i.runs?.[0] ?? null;
                        const extLabel =
                          i.externalProvider && typeof i.externalNumber === "number"
                            ? `${i.externalProvider} #${i.externalNumber}`
                            : i.externalProvider && i.externalId
                              ? `${i.externalProvider}:${i.externalId}`
                              : "";
                        return (
                          <tr key={i.id}>
                            <td style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              <Link to={`/issues/${i.id}`} title={i.title}>
                                {i.title}
                              </Link>
                            </td>
                            <td className="muted" style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {i.externalUrl ? (
                                <a href={i.externalUrl} target="_blank" rel="noreferrer" title={i.externalUrl}>
                                  {extLabel || "外部链接"}
                                </a>
                              ) : extLabel ? (
                                <span title={extLabel}>{extLabel}</span>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                            <td>
                              <StatusBadge status={i.status} />
                            </td>
                            <td>
                              {latestRun ? (
                                <div className="row gap" style={{ gap: 8, flexWrap: "wrap" }}>
                                  <StatusBadge status={latestRun.status} />
                                  <code title={latestRun.id}>{latestRun.id}</code>
                                </div>
                              ) : (
                                <span className="muted">-</span>
                              )}
                            </td>
                            <td className="muted">{new Date(i.createdAt).toLocaleString()}</td>
                            <td className="muted">{i.updatedAt ? new Date(i.updatedAt).toLocaleString() : "-"}</td>
                            <td className="muted">{i.archivedAt ? new Date(i.archivedAt).toLocaleString() : "-"}</td>
                            <td style={{ textAlign: "right" }}>
                              <button
                                type="button"
                                className="buttonSecondary"
                                onClick={() => onToggleArchived(i)}
                                disabled={archiveBusyId === i.id || archiveLoading}
                              >
                                {i.archivedAt ? "取消归档" : "归档"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : archiveLoading ? null : (
                <div className="muted" style={{ marginTop: 12 }}>
                  当前筛选条件下暂无数据
                </div>
              )}
            </>
          )}
        </section>
      </div>
        </div>
      </main>
    </div>
  );
}

