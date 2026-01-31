import { useCallback, useEffect, useState } from "react";

import { createProject, updateProject } from "../../../api/projects";
import { useAuth } from "../../../auth/AuthContext";
import type { Project } from "../../../types";
import type { WorkspaceNoticeMode } from "../adminUtils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  active: boolean;
  loading: boolean;
  projects: Project[];
  effectiveProject: Project | null;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onRefreshGlobal: () => Promise<void>;
  onSelectedProjectIdChange: (next: string) => void;
};

export function ProjectsSection(props: Props) {
  const {
    active,
    loading,
    projects,
    effectiveProject,
    effectiveProjectId,
    requireAdmin,
    setError,
    onRefreshGlobal,
    onSelectedProjectIdChange,
  } = props;

  const auth = useAuth();

  const [savingProjectEdit, setSavingProjectEdit] = useState(false);

  const [editName, setEditName] = useState("");
  const [editRepoUrl, setEditRepoUrl] = useState("");
  const [editScmType, setEditScmType] = useState("gitlab");
  const [editDefaultBranch, setEditDefaultBranch] = useState("main");
  const [editWorkspaceMode, setEditWorkspaceMode] = useState<"worktree" | "clone">(
    "worktree",
  );
  const [editGitAuthMode, setEditGitAuthMode] = useState<"https_pat" | "ssh">("https_pat");
  const [editDefaultRoleKey, setEditDefaultRoleKey] = useState("");

  const [editGitlabProjectId, setEditGitlabProjectId] = useState("");
  const [editGitlabAccessToken, setEditGitlabAccessToken] = useState("");
  const [editGitlabAccessTokenClear, setEditGitlabAccessTokenClear] = useState(false);
  const [editGitlabWebhookSecret, setEditGitlabWebhookSecret] = useState("");
  const [editGitlabWebhookSecretClear, setEditGitlabWebhookSecretClear] = useState(false);

  const [editGithubAccessToken, setEditGithubAccessToken] = useState("");
  const [editGithubAccessTokenClear, setEditGithubAccessTokenClear] = useState(false);
  const [editGithubPollingEnabled, setEditGithubPollingEnabled] = useState(false);

  const [editWorkspaceNoticeMode, setEditWorkspaceNoticeMode] =
    useState<WorkspaceNoticeMode>("default");
  const [editWorkspaceNoticeTemplate, setEditWorkspaceNoticeTemplate] = useState("");

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [projectScmType, setProjectScmType] = useState("gitlab");
  const [projectDefaultBranch, setProjectDefaultBranch] = useState("main");
  const [projectWorkspaceMode, setProjectWorkspaceMode] = useState<"worktree" | "clone">(
    "worktree",
  );
  const [projectGitAuthMode, setProjectGitAuthMode] = useState<"https_pat" | "ssh">("https_pat");
  const [projectGitlabProjectId, setProjectGitlabProjectId] = useState("");
  const [projectGitlabAccessToken, setProjectGitlabAccessToken] = useState("");
  const [projectGitlabWebhookSecret, setProjectGitlabWebhookSecret] = useState("");
  const [projectGithubAccessToken, setProjectGithubAccessToken] = useState("");
  const [projectGithubPollingEnabled, setProjectGithubPollingEnabled] = useState(false);
  const [projectAgentWorkspaceNoticeMode, setProjectAgentWorkspaceNoticeMode] =
    useState<WorkspaceNoticeMode>("default");
  const [projectAgentWorkspaceNoticeTemplate, setProjectAgentWorkspaceNoticeTemplate] =
    useState("");
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!effectiveProject) return;

    setEditName(effectiveProject.name ?? "");
    setEditRepoUrl(effectiveProject.repoUrl ?? "");
    setEditScmType(effectiveProject.scmType ?? "gitlab");
    setEditDefaultBranch(effectiveProject.defaultBranch ?? "main");
    setEditWorkspaceMode(effectiveProject.workspaceMode ?? "worktree");
    setEditGitAuthMode(effectiveProject.gitAuthMode ?? "https_pat");
    setEditDefaultRoleKey(effectiveProject.defaultRoleKey ?? "");
    setEditGitlabProjectId(
      typeof effectiveProject.gitlabProjectId === "number"
        ? String(effectiveProject.gitlabProjectId)
        : "",
    );
    setEditGithubPollingEnabled(Boolean(effectiveProject.githubPollingEnabled));

    setEditGitlabAccessToken("");
    setEditGitlabAccessTokenClear(false);
    setEditGitlabWebhookSecret("");
    setEditGitlabWebhookSecretClear(false);
    setEditGithubAccessToken("");
    setEditGithubAccessTokenClear(false);

    const raw = effectiveProject.agentWorkspaceNoticeTemplate;
    if (raw === "") {
      setEditWorkspaceNoticeMode("hidden");
      setEditWorkspaceNoticeTemplate("");
    } else if (raw === null || raw === undefined) {
      setEditWorkspaceNoticeMode("default");
      setEditWorkspaceNoticeTemplate("");
    } else {
      setEditWorkspaceNoticeMode("custom");
      setEditWorkspaceNoticeTemplate(String(raw));
    }
  }, [effectiveProject, effectiveProjectId]);

  useEffect(() => {
    if (!active) return;
    if (loading) return;
    if (!projects.length) setCreateOpen(true);
  }, [active, loading, projects.length]);

  const onResetProjectEdit = useCallback(() => {
    if (!effectiveProject) return;
    setEditName(effectiveProject.name ?? "");
    setEditRepoUrl(effectiveProject.repoUrl ?? "");
    setEditScmType(effectiveProject.scmType ?? "gitlab");
    setEditDefaultBranch(effectiveProject.defaultBranch ?? "main");
    setEditWorkspaceMode(effectiveProject.workspaceMode ?? "worktree");
    setEditGitAuthMode(effectiveProject.gitAuthMode ?? "https_pat");
    setEditDefaultRoleKey(effectiveProject.defaultRoleKey ?? "");
    setEditGitlabProjectId(
      typeof effectiveProject.gitlabProjectId === "number"
        ? String(effectiveProject.gitlabProjectId)
        : "",
    );
    setEditGithubPollingEnabled(Boolean(effectiveProject.githubPollingEnabled));

    setEditGitlabAccessToken("");
    setEditGitlabAccessTokenClear(false);
    setEditGitlabWebhookSecret("");
    setEditGitlabWebhookSecretClear(false);
    setEditGithubAccessToken("");
    setEditGithubAccessTokenClear(false);

    const raw = effectiveProject.agentWorkspaceNoticeTemplate;
    if (raw === "") {
      setEditWorkspaceNoticeMode("hidden");
      setEditWorkspaceNoticeTemplate("");
    } else if (raw === null || raw === undefined) {
      setEditWorkspaceNoticeMode("default");
      setEditWorkspaceNoticeTemplate("");
    } else {
      setEditWorkspaceNoticeMode("custom");
      setEditWorkspaceNoticeTemplate(String(raw));
    }
  }, [effectiveProject]);

  const onCreateProject = useCallback(
    async (e: React.FormEvent) => {
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
          agentWorkspaceNoticeTemplate:
            projectAgentWorkspaceNoticeMode === "default"
              ? undefined
              : projectAgentWorkspaceNoticeMode === "hidden"
                ? ""
                : projectAgentWorkspaceNoticeTemplate,
          gitlabProjectId: Number.isFinite(gitlabProjectId ?? NaN) ? gitlabProjectId : undefined,
          gitlabAccessToken: projectGitlabAccessToken.trim() || undefined,
          gitlabWebhookSecret: projectGitlabWebhookSecret.trim() || undefined,
          githubAccessToken: projectGithubAccessToken.trim() || undefined,
          githubPollingEnabled: projectGithubPollingEnabled,
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
        setProjectGithubPollingEnabled(false);
        setProjectAgentWorkspaceNoticeMode("default");
        setProjectAgentWorkspaceNoticeTemplate("");
        await onRefreshGlobal();
        onSelectedProjectIdChange(p.id);
        setCreateOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      onRefreshGlobal,
      onSelectedProjectIdChange,
      projectAgentWorkspaceNoticeMode,
      projectAgentWorkspaceNoticeTemplate,
      projectDefaultBranch,
      projectGitAuthMode,
      projectGithubAccessToken,
      projectGithubPollingEnabled,
      projectGitlabAccessToken,
      projectGitlabProjectId,
      projectGitlabWebhookSecret,
      projectName,
      projectRepoUrl,
      projectScmType,
      projectWorkspaceMode,
      requireAdmin,
      setError,
    ],
  );

  const onSaveProjectEdit = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先创建 Project");
      return;
    }

    const name = editName.trim();
    const repoUrl = editRepoUrl.trim();
    if (!name) {
      setError("Project 名称不能为空");
      return;
    }
    if (!repoUrl) {
      setError("Repo URL 不能为空");
      return;
    }

    const patchSecret = (draft: string, clear: boolean): string | null | undefined => {
      if (clear) return null;
      const v = draft.trim();
      return v ? v : undefined;
    };

    const gitlabProjectIdRaw = editGitlabProjectId.trim();
    let gitlabProjectId: number | null | undefined;
    if (gitlabProjectIdRaw === "") {
      gitlabProjectId = null;
    } else {
      const parsed = Number(gitlabProjectIdRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("GitLab Project ID 需要正整数（留空=清除）");
        return;
      }
      gitlabProjectId = parsed;
    }

    const agentWorkspaceNoticeTemplate =
      editWorkspaceNoticeMode === "default"
        ? null
        : editWorkspaceNoticeMode === "hidden"
          ? ""
          : editWorkspaceNoticeTemplate;

    setSavingProjectEdit(true);
    try {
      await updateProject(effectiveProjectId, {
        name,
        repoUrl,
        scmType: editScmType.trim() || undefined,
        defaultBranch: editDefaultBranch.trim() || undefined,
        workspaceMode: editWorkspaceMode,
        gitAuthMode: editGitAuthMode,
        defaultRoleKey: editDefaultRoleKey.trim() ? editDefaultRoleKey.trim() : null,
        agentWorkspaceNoticeTemplate,
        ...(editScmType === "gitlab"
          ? {
              gitlabProjectId,
              gitlabAccessToken: patchSecret(editGitlabAccessToken, editGitlabAccessTokenClear),
              gitlabWebhookSecret: patchSecret(
                editGitlabWebhookSecret,
                editGitlabWebhookSecretClear,
              ),
            }
          : {}),
        ...(editScmType === "github"
          ? {
              githubAccessToken: patchSecret(editGithubAccessToken, editGithubAccessTokenClear),
              githubPollingEnabled: editGithubPollingEnabled,
            }
          : {}),
      });
      await onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProjectEdit(false);
    }
  }, [
    editDefaultBranch,
    editDefaultRoleKey,
    editGitAuthMode,
    editGithubAccessToken,
    editGithubAccessTokenClear,
    editGithubPollingEnabled,
    editGitlabAccessToken,
    editGitlabAccessTokenClear,
    editGitlabProjectId,
    editGitlabWebhookSecret,
    editGitlabWebhookSecretClear,
    editName,
    editRepoUrl,
    editScmType,
    editWorkspaceMode,
    editWorkspaceNoticeMode,
    editWorkspaceNoticeTemplate,
    effectiveProjectId,
    onRefreshGlobal,
    requireAdmin,
    setError,
  ]);

  const canSave = auth.hasRole(["admin"]);

  return (
    <>
      <section className="card" hidden={!active}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>当前 Project</h2>
        {loading ? null : projects.length ? (
          <div className="muted">当前共 {projects.length} 个</div>
        ) : (
          <div className="muted">暂无 Project，请先创建</div>
        )}

        {loading ? (
          <div className="muted">加载中…</div>
        ) : effectiveProject ? (
          <>
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
              <div className="kvItem">
                <div className="muted">Workspace</div>
                <code>{effectiveProject.workspaceMode ?? "worktree"}</code>
              </div>
              <div className="kvItem">
                <div className="muted">Git 认证</div>
                <code>{effectiveProject.gitAuthMode ?? "https_pat"}</code>
              </div>
              <div className="kvItem">
                <div className="muted">默认 Role</div>
                {effectiveProject.defaultRoleKey ? (
                  <code>{effectiveProject.defaultRoleKey}</code>
                ) : (
                  <span className="muted">—</span>
                )}
              </div>
            </div>

            <div className="kvGrid" style={{ marginTop: 12 }}>
              <div className="kvItem">
                <div className="muted">GitLab Token</div>
                <div>{effectiveProject.hasGitlabAccessToken ? "已设置" : "未设置"}</div>
              </div>
              <div className="kvItem">
                <div className="muted">GitHub Token</div>
                <div>{effectiveProject.hasGithubAccessToken ? "已设置" : "未设置"}</div>
              </div>
              <div className="kvItem">
                <div className="muted">创建时间</div>
                <div className="muted">
                  {effectiveProject.createdAt
                    ? new Date(effectiveProject.createdAt).toLocaleString()
                    : "—"}
                </div>
              </div>
              {String(effectiveProject.scmType ?? "").toLowerCase() === "github" ? (
                <div className="kvItem">
                  <div className="muted">轮询</div>
                  <div className="muted">
                    {effectiveProject.githubPollingEnabled ? "已开启" : "未开启"}
                    {effectiveProject.githubPollingCursor
                      ? ` · 上次：${new Date(effectiveProject.githubPollingCursor).toLocaleString()}`
                      : ""}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <div className="muted">暂无 Project，请先创建</div>
        )}
      </section>

      <section className="card" hidden={!active}>
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>项目管理</h2>
            <div className="muted">保存后会影响新建 Run 的行为（凭证仅 admin 可操作）。</div>
          </div>
          <div className="row gap" style={{ flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onResetProjectEdit}
              disabled={!effectiveProjectId || savingProjectEdit}
            >
              重置
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onSaveProjectEdit()}
              disabled={!effectiveProjectId || savingProjectEdit || !canSave}
            >
              {savingProjectEdit ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>

        {!effectiveProjectId ? (
          <div className="muted" style={{ marginTop: 10 }}>
            请先创建/选择 Project
          </div>
        ) : (
          <div className="form" style={{ marginTop: 10 }}>
            <h3 style={{ marginTop: 0 }}>基础</h3>
            <label className="label">
              名称 *
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                disabled={savingProjectEdit}
              />
            </label>
            <label className="label">
              Repo URL *
              <Input
                value={editRepoUrl}
                onChange={(e) => setEditRepoUrl(e.target.value)}
                disabled={savingProjectEdit}
              />
            </label>
            <label className="label">
              SCM
              <Select value={editScmType} onValueChange={setEditScmType} disabled={savingProjectEdit}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gitlab">gitlab</SelectItem>
                  <SelectItem value="github">github</SelectItem>
                  <SelectItem value="gitee">gitee</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="label">
              默认分支
              <Input
                value={editDefaultBranch}
                onChange={(e) => setEditDefaultBranch(e.target.value)}
                disabled={savingProjectEdit}
              />
            </label>
            <label className="label">
              Workspace 模式
              <Select
                value={editWorkspaceMode}
                onValueChange={(v) => setEditWorkspaceMode(v as any)}
                disabled={savingProjectEdit}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worktree">worktree（推荐）</SelectItem>
                  <SelectItem value="clone">clone</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="label">
              Git 认证
              <Select
                value={editGitAuthMode}
                onValueChange={(v) => setEditGitAuthMode(v as any)}
                disabled={savingProjectEdit}
              >
                <SelectTrigger className="w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="https_pat">https_pat（token）</SelectItem>
                  <SelectItem value="ssh">ssh</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="label">
              默认 Role Key（可选）
              <Input
                value={editDefaultRoleKey}
                onChange={(e) => setEditDefaultRoleKey(e.target.value)}
                disabled={savingProjectEdit}
                placeholder="例如：backend-dev（留空=清除）"
              />
            </label>

            <details style={{ marginTop: 12 }}>
              <summary>Agent 工作区提示（可选）</summary>
              <div className="muted" style={{ marginTop: 6 }}>
                支持模板变量：<code>{"{{workspace}}"}</code> <code>{"{{branch}}"}</code>{" "}
                <code>{"{{repoUrl}}"}</code> <code>{"{{scmType}}"}</code>{" "}
                <code>{"{{defaultBranch}}"}</code> <code>{"{{baseBranch}}"}</code>。平台默认可通过{" "}
                <code>AGENT_WORKSPACE_NOTICE_TEMPLATE</code> 配置。
              </div>
              <label className="label">
                模式
                <Select
                  value={editWorkspaceNoticeMode}
                  disabled={savingProjectEdit}
                  onValueChange={(v) => setEditWorkspaceNoticeMode(v as WorkspaceNoticeMode)}
                >
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">使用平台默认</SelectItem>
                    <SelectItem value="hidden">隐藏提示</SelectItem>
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {editWorkspaceNoticeMode === "custom" ? (
                <label className="label">
                  模板
                  <Textarea
                    value={editWorkspaceNoticeTemplate}
                    disabled={savingProjectEdit}
                    onChange={(e) => setEditWorkspaceNoticeTemplate(e.target.value)}
                    rows={4}
                    placeholder="例如：请在 {{workspace}} 中修改；若为 Git 仓库请 git commit。"
                  />
                </label>
              ) : null}
            </details>

            {editScmType === "gitlab" ? (
              <details style={{ marginTop: 12 }}>
                <summary>GitLab 配置（可选）</summary>
                <label className="label">
                  GitLab Project ID（留空=清除）
                  <Input
                    value={editGitlabProjectId}
                    onChange={(e) => setEditGitlabProjectId(e.target.value)}
                    placeholder="12345"
                    disabled={savingProjectEdit}
                  />
                </label>
                <label className="label">
                  GitLab Access Token（留空=不改）
                  <Input
                    type="password"
                    value={editGitlabAccessToken}
                    onChange={(e) => setEditGitlabAccessToken(e.target.value)}
                    placeholder={effectiveProject?.hasGitlabAccessToken ? "已设置（留空不改）" : "glpat-..."}
                    disabled={savingProjectEdit || editGitlabAccessTokenClear}
                  />
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox
                      checked={editGitlabAccessTokenClear}
                      onCheckedChange={(v) => setEditGitlabAccessTokenClear(v === true)}
                      disabled={savingProjectEdit}
                    />
                    <span className="muted">清除 token</span>
                  </span>
                </label>
                <label className="label">
                  GitLab Webhook Secret（留空=不改）
                  <Input
                    type="password"
                    value={editGitlabWebhookSecret}
                    onChange={(e) => setEditGitlabWebhookSecret(e.target.value)}
                    placeholder="留空不改"
                    disabled={savingProjectEdit || editGitlabWebhookSecretClear}
                  />
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox
                      checked={editGitlabWebhookSecretClear}
                      onCheckedChange={(v) => setEditGitlabWebhookSecretClear(v === true)}
                      disabled={savingProjectEdit}
                    />
                    <span className="muted">清除 secret</span>
                  </span>
                </label>
              </details>
            ) : editScmType === "github" ? (
              <details style={{ marginTop: 12 }}>
                <summary>GitHub 配置（可选）</summary>
                <label className="label">
                  GitHub Access Token（留空=不改）
                  <Input
                    type="password"
                    value={editGithubAccessToken}
                    onChange={(e) => setEditGithubAccessToken(e.target.value)}
                    placeholder={effectiveProject?.hasGithubAccessToken ? "已设置（留空不改）" : "ghp_... / github_pat_..."}
                    disabled={savingProjectEdit || editGithubAccessTokenClear}
                  />
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox
                      checked={editGithubAccessTokenClear}
                      onCheckedChange={(v) => setEditGithubAccessTokenClear(v === true)}
                      disabled={savingProjectEdit}
                    />
                    <span className="muted">清除 token</span>
                  </span>
                </label>
                <label className="label">
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox
                      checked={editGithubPollingEnabled}
                      onCheckedChange={(v) => setEditGithubPollingEnabled(v === true)}
                      disabled={savingProjectEdit}
                    />
                    启用 GitHub 轮询监听（每分钟导入 Issues/PR）
                  </span>
                </label>
                <div className="muted">
                  上次同步：{effectiveProject?.githubPollingCursor ? new Date(effectiveProject.githubPollingCursor).toLocaleString() : "未同步"}
                </div>
              </details>
            ) : null}

            {!canSave ? (
              <div className="muted" style={{ marginTop: 10 }}>
                需要管理员权限才能保存 Project 配置。
              </div>
            ) : null}
          </div>
        )}

        <div className="rounded-lg border bg-card p-4" style={{ marginTop: 14 }}>
          <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 800 }}>创建 Project</div>
              <div className="muted">用于配置仓库、SCM、认证方式等。</div>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={() => setCreateOpen((v) => !v)}>
              {createOpen ? "收起" : "展开"}
            </Button>
          </div>

          {createOpen ? (
            <form onSubmit={(e) => void onCreateProject(e)} className="form" style={{ marginTop: 12 }}>
            <div className="grid2" style={{ marginBottom: 0 }}>
              <div>
                <label className="label">
                  名称 *
                  <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                </label>
                <label className="label">
                  Repo URL *
                  <Input value={projectRepoUrl} onChange={(e) => setProjectRepoUrl(e.target.value)} />
                </label>
                <label className="label">
                  SCM
                  <Select value={projectScmType} onValueChange={setProjectScmType}>
                    <SelectTrigger className="w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gitlab">gitlab</SelectItem>
                      <SelectItem value="github">github</SelectItem>
                      <SelectItem value="gitee">gitee</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>

              <div>
                <label className="label">
                  默认分支
                  <Input value={projectDefaultBranch} onChange={(e) => setProjectDefaultBranch(e.target.value)} />
                </label>
                <label className="label">
                  Workspace 模式
                  <Select value={projectWorkspaceMode} onValueChange={(v) => setProjectWorkspaceMode(v as any)}>
                    <SelectTrigger className="w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="worktree">worktree（推荐）</SelectItem>
                      <SelectItem value="clone">clone</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="label">
                  Git 认证
                  <Select value={projectGitAuthMode} onValueChange={(v) => setProjectGitAuthMode(v as any)}>
                    <SelectTrigger className="w-[220px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="https_pat">https_pat（token）</SelectItem>
                      <SelectItem value="ssh">ssh</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              </div>
            </div>

            <details style={{ marginTop: 10 }}>
              <summary>Agent 工作区提示（可选）</summary>
              <div className="muted" style={{ marginTop: 6 }}>
                支持模板变量：<code>{"{{workspace}}"}</code> <code>{"{{branch}}"}</code>{" "}
                <code>{"{{repoUrl}}"}</code> <code>{"{{scmType}}"}</code>{" "}
                <code>{"{{defaultBranch}}"}</code> <code>{"{{baseBranch}}"}</code>。
              </div>
              <label className="label">
                模式
                <Select value={projectAgentWorkspaceNoticeMode} onValueChange={(v) => setProjectAgentWorkspaceNoticeMode(v as WorkspaceNoticeMode)}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">使用平台默认</SelectItem>
                    <SelectItem value="hidden">隐藏提示</SelectItem>
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {projectAgentWorkspaceNoticeMode === "custom" ? (
                <label className="label">
                  模板
                  <Textarea
                    value={projectAgentWorkspaceNoticeTemplate}
                    onChange={(e) => setProjectAgentWorkspaceNoticeTemplate(e.target.value)}
                    rows={4}
                    placeholder="例如：请在 {{workspace}} 中修改；若为 Git 仓库请 git commit。"
                  />
                </label>
              ) : null}
            </details>

            {projectScmType === "gitlab" ? (
              <details style={{ marginTop: 10 }}>
                <summary>GitLab 配置（可选）</summary>
                <label className="label">
                  GitLab Project ID
                  <Input value={projectGitlabProjectId} onChange={(e) => setProjectGitlabProjectId(e.target.value)} placeholder="12345" />
                </label>
                <label className="label">
                  GitLab Access Token
                  <Input type="password" value={projectGitlabAccessToken} onChange={(e) => setProjectGitlabAccessToken(e.target.value)} placeholder="glpat-..." />
                </label>
                <label className="label">
                  GitLab Webhook Secret（可选）
                  <Input type="password" value={projectGitlabWebhookSecret} onChange={(e) => setProjectGitlabWebhookSecret(e.target.value)} />
                </label>
              </details>
            ) : projectScmType === "github" ? (
              <details style={{ marginTop: 10 }}>
                <summary>GitHub 配置（可选）</summary>
                <label className="label">
                  GitHub Access Token
                  <Input type="password" value={projectGithubAccessToken} onChange={(e) => setProjectGithubAccessToken(e.target.value)} placeholder="ghp_... / github_pat_..." />
                </label>
                <label className="label">
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox checked={projectGithubPollingEnabled} onCheckedChange={(v) => setProjectGithubPollingEnabled(v === true)} />
                    启用 GitHub 轮询监听（每分钟导入 Issues/PR）
                  </span>
                </label>
              </details>
            ) : null}

            <Button type="submit" disabled={!projectName.trim() || !projectRepoUrl.trim()}>
              创建
            </Button>
            </form>
          ) : (
            <div className="muted" style={{ marginTop: 12 }}>
              点击右上角「展开」开始创建。
            </div>
          )}
        </div>
      </section>
    </>
  );
}
