import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { approveApproval, listApprovals, rejectApproval } from "../api/approvals";
import { createIssue, listIssues, updateIssue } from "../api/issues";
import { importGitHubIssue } from "../api/githubIssues";
import { getPmPolicy, updatePmPolicy } from "../api/policies";
import { createProject, listProjects } from "../api/projects";
import { createRole } from "../api/roles";
import { useAuth } from "../auth/AuthContext";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Approval, Issue, IssueStatus, PmPolicy, Project } from "../types";
import { getShowArchivedIssues, setShowArchivedIssues } from "../utils/settings";

const ADMIN_SECTION_KEYS = ["approvals", "settings", "projects", "issues", "roles", "policy", "archive"] as const;
type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

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

function isArchivableStatus(status: IssueStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function AdminPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approvalBusyId, setApprovalBusyId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<AdminSectionKey>(() => getSectionFromSearch(location.search) ?? "projects");

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

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

  const effectiveProject = useMemo(() => {
    return effectiveProjectId ? projects.find((p) => p.id === effectiveProjectId) ?? null : null;
  }, [effectiveProjectId, projects]);

  const archivableIssues = useMemo(() => {
    return issues
      .filter((i) => i.projectId === effectiveProjectId)
      .filter((i) => isArchivableStatus(i.status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [effectiveProjectId, issues]);

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

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    try {
      const next = !issue.archivedAt;
      await updateIssue(issue.id, { archived: next });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      archive: { title: "Issue 归档", desc: "管理已完成/失败/取消的 Issue 归档状态" }
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
          <button onClick={() => refresh()} disabled={loading}>
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
              onClick={() => setPolicyText(JSON.stringify({ version: 1, automation: { autoStartIssue: true }, approvals: { requireForActions: ["merge_pr"] }, sensitivePaths: [] } satisfies PmPolicy, null, 2))}
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
            placeholder='{"version":1,"automation":{"autoStartIssue":true},"approvals":{"requireForActions":["merge_pr"]},"sensitivePaths":[] }'
          />
        )}

        <div className="muted" style={{ marginTop: 8 }}>
          后端接口：<code>GET/PUT /api/policies?projectId=...</code>（存储在 <code>Project.branchProtection.pmPolicy</code>）。
        </div>
      </section>

      <div className="grid2" hidden={activeSection === "approvals" || activeSection === "settings" || activeSection === "policy"}>
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

        <section className="card" hidden={activeSection !== "issues"}>
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

        <section className="card" hidden={activeSection !== "issues"}>
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
          <h2 style={{ marginTop: 0 }}>归档（已完成/失败/取消）</h2>
          {!effectiveProjectId ? (
            <div className="muted">请先创建 Project</div>
          ) : archivableIssues.length ? (
            <div className="tableScroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>状态</th>
                    <th>归档</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {archivableIssues.map((i) => (
                    <tr key={i.id}>
                      <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {i.title}
                      </td>
                      <td className="muted">{i.status}</td>
                      <td className="muted">{i.archivedAt ? "已归档" : "-"}</td>
                      <td style={{ textAlign: "right" }}>
                        <button type="button" className="buttonSecondary" onClick={() => onToggleArchived(i)}>
                          {i.archivedAt ? "取消归档" : "归档"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="muted">当前 Project 暂无可归档 Issue</div>
          )}
        </section>
      </div>
        </div>
      </main>
    </div>
  );
}

