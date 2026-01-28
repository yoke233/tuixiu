import { useCallback, useEffect, useState } from "react";

import { createProject, updateProject } from "../../../api/projects";
import { useAuth } from "../../../auth/AuthContext";
import type { Project } from "../../../types";
import type { WorkspaceNoticeMode } from "../adminUtils";

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

  const [savingGithubPollingEnabled, setSavingGithubPollingEnabled] = useState(false);
  const [agentWorkspaceNoticeMode, setAgentWorkspaceNoticeMode] = useState<WorkspaceNoticeMode>("default");
  const [agentWorkspaceNoticeTemplate, setAgentWorkspaceNoticeTemplate] = useState("");
  const [savingAgentWorkspaceNotice, setSavingAgentWorkspaceNotice] = useState(false);

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [projectScmType, setProjectScmType] = useState("gitlab");
  const [projectDefaultBranch, setProjectDefaultBranch] = useState("main");
  const [projectGitAuthMode, setProjectGitAuthMode] = useState<"https_pat" | "ssh">("https_pat");
  const [projectGitlabProjectId, setProjectGitlabProjectId] = useState("");
  const [projectGitlabAccessToken, setProjectGitlabAccessToken] = useState("");
  const [projectGitlabWebhookSecret, setProjectGitlabWebhookSecret] = useState("");
  const [projectGithubAccessToken, setProjectGithubAccessToken] = useState("");
  const [projectGithubPollingEnabled, setProjectGithubPollingEnabled] = useState(false);
  const [projectAgentWorkspaceNoticeMode, setProjectAgentWorkspaceNoticeMode] = useState<WorkspaceNoticeMode>("default");
  const [projectAgentWorkspaceNoticeTemplate, setProjectAgentWorkspaceNoticeTemplate] = useState("");

  useEffect(() => {
    const raw = effectiveProject?.agentWorkspaceNoticeTemplate;
    if (raw === "") {
      setAgentWorkspaceNoticeMode("hidden");
      setAgentWorkspaceNoticeTemplate("");
      return;
    }
    if (raw === null || raw === undefined) {
      setAgentWorkspaceNoticeMode("default");
      setAgentWorkspaceNoticeTemplate("");
      return;
    }
    setAgentWorkspaceNoticeMode("custom");
    setAgentWorkspaceNoticeTemplate(String(raw));
  }, [effectiveProject?.agentWorkspaceNoticeTemplate, effectiveProjectId]);

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
      requireAdmin,
      setError,
    ],
  );

  const onToggleGithubPollingEnabled = useCallback(
    async (next: boolean) => {
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }

      setSavingGithubPollingEnabled(true);
      try {
        await updateProject(effectiveProjectId, { githubPollingEnabled: next });
        await onRefreshGlobal();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingGithubPollingEnabled(false);
      }
    },
    [effectiveProjectId, onRefreshGlobal, requireAdmin, setError],
  );

  const onSaveAgentWorkspaceNotice = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先创建 Project");
      return;
    }

    setSavingAgentWorkspaceNotice(true);
    try {
      const value =
        agentWorkspaceNoticeMode === "default"
          ? null
          : agentWorkspaceNoticeMode === "hidden"
            ? ""
            : agentWorkspaceNoticeTemplate;
      await updateProject(effectiveProjectId, { agentWorkspaceNoticeTemplate: value });
      await onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAgentWorkspaceNotice(false);
    }
  }, [
    agentWorkspaceNoticeMode,
    agentWorkspaceNoticeTemplate,
    effectiveProjectId,
    onRefreshGlobal,
    requireAdmin,
    setError,
  ]);

  return (
    <>
      <section className="card" hidden={!active}>
        <h2 style={{ marginTop: 0 }}>当前 Project</h2>

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
            </div>

            {String(effectiveProject.scmType ?? "").toLowerCase() === "github" ? (
              <div style={{ marginTop: 12 }}>
                <label className="label" style={{ marginBottom: 6 }}>
                  GitHub 轮询监听（每分钟导入 Issues/PR）
                  <input
                    type="checkbox"
                    checked={Boolean(effectiveProject.githubPollingEnabled)}
                    disabled={savingGithubPollingEnabled || !auth.hasRole(["admin"])}
                    onChange={(e) => void onToggleGithubPollingEnabled(e.target.checked)}
                  />
                </label>
                <div className="muted">
                  上次同步：
                  {effectiveProject.githubPollingCursor ? new Date(effectiveProject.githubPollingCursor).toLocaleString() : "未同步"}
                </div>
              </div>
            ) : null}

            <details style={{ marginTop: 12 }}>
              <summary>Agent 工作区提示（可选）</summary>
              <div className="muted" style={{ marginTop: 6 }}>
                支持模板变量：
                <code>{"{{workspace}}"}</code> <code>{"{{branch}}"}</code> <code>{"{{repoUrl}}"}</code>{" "}
                <code>{"{{scmType}}"}</code> <code>{"{{defaultBranch}}"}</code> <code>{"{{baseBranch}}"}</code>。平台默认可通过{" "}
                <code>AGENT_WORKSPACE_NOTICE_TEMPLATE</code> 配置。
              </div>
              <div className="form" style={{ marginTop: 10 }}>
                <label className="label">
                  模式
                  <select
                    value={agentWorkspaceNoticeMode}
                    disabled={savingAgentWorkspaceNotice || !auth.hasRole(["admin"])}
                    onChange={(e) => setAgentWorkspaceNoticeMode(e.target.value as WorkspaceNoticeMode)}
                  >
                    <option value="default">使用平台默认</option>
                    <option value="hidden">隐藏提示</option>
                    <option value="custom">自定义</option>
                  </select>
                </label>
                {agentWorkspaceNoticeMode === "custom" ? (
                  <label className="label">
                    模板
                    <textarea
                      value={agentWorkspaceNoticeTemplate}
                      disabled={savingAgentWorkspaceNotice || !auth.hasRole(["admin"])}
                      onChange={(e) => setAgentWorkspaceNoticeTemplate(e.target.value)}
                      rows={4}
                      placeholder="例如：请在 {{workspace}} 中修改；若为 Git 仓库请 git commit。"
                    />
                  </label>
                ) : null}
                <button type="button" onClick={() => void onSaveAgentWorkspaceNotice()} disabled={savingAgentWorkspaceNotice || !auth.hasRole(["admin"])}>
                  {savingAgentWorkspaceNotice ? "保存中…" : "保存"}
                </button>
              </div>
            </details>
          </>
        ) : (
          <div className="muted">暂无 Project，请先创建</div>
        )}
      </section>

      <section className="card" hidden={!active}>
        <h2 style={{ marginTop: 0 }}>Projects</h2>
        {loading ? <div className="muted">加载中…</div> : projects.length ? <div className="muted">当前共 {projects.length} 个</div> : <div className="muted">暂无 Project，请先创建</div>}

        <form onSubmit={(e) => void onCreateProject(e)} className="form">
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
            Git 认证
            <select value={projectGitAuthMode} onChange={(e) => setProjectGitAuthMode(e.target.value as "https_pat" | "ssh")}>
              <option value="https_pat">https_pat（token）</option>
              <option value="ssh">ssh</option>
            </select>
          </label>
          <details>
            <summary>Agent 工作区提示（可选）</summary>
            <div className="muted" style={{ marginTop: 6 }}>
              支持模板变量：
              <code>{"{{workspace}}"}</code> <code>{"{{branch}}"}</code> <code>{"{{repoUrl}}"}</code> <code>{"{{scmType}}"}</code>{" "}
              <code>{"{{defaultBranch}}"}</code> <code>{"{{baseBranch}}"}</code>。
            </div>
            <label className="label">
              模式
              <select value={projectAgentWorkspaceNoticeMode} onChange={(e) => setProjectAgentWorkspaceNoticeMode(e.target.value as WorkspaceNoticeMode)}>
                <option value="default">使用平台默认</option>
                <option value="hidden">隐藏提示</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            {projectAgentWorkspaceNoticeMode === "custom" ? (
              <label className="label">
                模板
                <textarea
                  value={projectAgentWorkspaceNoticeTemplate}
                  onChange={(e) => setProjectAgentWorkspaceNoticeTemplate(e.target.value)}
                  rows={4}
                  placeholder="例如：请在 {{workspace}} 中修改；若为 Git 仓库请 git commit。"
                />
              </label>
            ) : null}
          </details>

          {projectScmType === "gitlab" ? (
            <details>
              <summary>GitLab 配置（可选）</summary>
              <label className="label">
                GitLab Project ID
                <input value={projectGitlabProjectId} onChange={(e) => setProjectGitlabProjectId(e.target.value)} placeholder="12345" />
              </label>
              <label className="label">
                GitLab Access Token
                <input type="password" value={projectGitlabAccessToken} onChange={(e) => setProjectGitlabAccessToken(e.target.value)} placeholder="glpat-..." />
              </label>
              <label className="label">
                GitLab Webhook Secret（可选）
                <input type="password" value={projectGitlabWebhookSecret} onChange={(e) => setProjectGitlabWebhookSecret(e.target.value)} />
              </label>
            </details>
          ) : projectScmType === "github" ? (
            <details>
              <summary>GitHub 配置（可选）</summary>
              <label className="label">
                GitHub Access Token
                <input type="password" value={projectGithubAccessToken} onChange={(e) => setProjectGithubAccessToken(e.target.value)} placeholder="ghp_... / github_pat_..." />
              </label>
              <label className="label">
                启用 GitHub 轮询监听（每分钟导入 Issues/PR）
                <input type="checkbox" checked={projectGithubPollingEnabled} onChange={(e) => setProjectGithubPollingEnabled(e.target.checked)} />
              </label>
            </details>
          ) : null}

          <button type="submit" disabled={!projectName.trim() || !projectRepoUrl.trim()}>
            创建
          </button>
        </form>
      </section>
    </>
  );
}
