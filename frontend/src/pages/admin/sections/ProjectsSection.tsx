import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";

import { createGitCredential, listGitCredentials, setGitCredentialDefaults, updateGitCredential } from "@/api/gitCredentials";
import { createProject, updateProject } from "@/api/projects";
import { getProjectScmConfig, updateProjectScmConfig } from "@/api/projectScmConfig";
import { useAuth } from "@/auth/AuthContext";
import type { GitAuthMode, GitCredential, Project, ProjectScmConfig } from "@/types";
import type { WorkspaceNoticeMode } from "@/pages/admin/adminUtils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

type ManageMode = "edit" | "create";

type ProjectManageDraft = {
  name: string;
  repoUrl: string;
  scmType: string;
  defaultBranch: string;
  workspaceMode: "worktree" | "clone";
  workspacePolicy: "git" | "mount" | "empty" | "bundle";
  defaultRoleKey: string;
  workspaceNoticeMode: WorkspaceNoticeMode;
  workspaceNoticeTemplate: string;
};

function ProjectManageForm(props: {
  mode: ManageMode;
  effectiveProjectId: string;
  saving: boolean;
  canSave: boolean;
  draft: ProjectManageDraft;
  onChange: (patch: Partial<ProjectManageDraft>) => void;
  onReset: () => void;
  onSubmit: () => Promise<void> | void;
}) {
  const { mode, effectiveProjectId, saving, canSave, draft, onChange, onReset, onSubmit } = props;

  const submitLabel = mode === "edit" ? "保存" : "创建";
  const resetLabel = mode === "edit" ? "重置" : "清空";
  const title = mode === "edit" ? "编辑当前项目" : "创建新项目";
  const subtitle =
    mode === "edit"
      ? effectiveProjectId
        ? (
          <>
            projectId: <code>{effectiveProjectId}</code>
          </>
        )
        : "—"
      : "用于配置仓库与基础信息。";

  const nameTrimmed = draft.name.trim();
  const repoUrlTrimmed = draft.repoUrl.trim();
  const submitDisabled = saving || !canSave || !nameTrimmed || !repoUrlTrimmed || (mode === "edit" && !effectiveProjectId);

  return (
    <div className="rounded-lg border bg-card p-4" style={{ marginTop: 14 }}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          <div className="muted" style={{ marginTop: 4 }}>
            {subtitle}
          </div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" size="sm" onClick={onReset} disabled={saving}>
            {resetLabel}
          </Button>
          <Button type="button" size="sm" onClick={() => void onSubmit()} disabled={submitDisabled}>
            {saving ? "处理中…" : submitLabel}
          </Button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        className="form"
        style={{ marginTop: 12 }}
      >
        <h3 style={{ marginTop: 0 }}>基础</h3>
        <label className="label">
          名称 *
          <Input value={draft.name} onChange={(e) => onChange({ name: e.target.value })} disabled={saving} />
        </label>
        <label className="label">
          Repo URL *
          <Input value={draft.repoUrl} onChange={(e) => onChange({ repoUrl: e.target.value })} disabled={saving} />
        </label>
        <label className="label">
          SCM
          <Select value={draft.scmType} onValueChange={(v) => onChange({ scmType: v })} disabled={saving}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gitlab">gitlab</SelectItem>
              <SelectItem value="github">github</SelectItem>
              <SelectItem value="gitee">gitee</SelectItem>
              <SelectItem value="git">git（普通）</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="label">
          默认分支
          <Input value={draft.defaultBranch} onChange={(e) => onChange({ defaultBranch: e.target.value })} disabled={saving} />
        </label>
        <label className="label">
          Workspace 模式
          <Select value={draft.workspaceMode} onValueChange={(v) => onChange({ workspaceMode: v as ProjectManageDraft["workspaceMode"] })} disabled={saving}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="worktree">worktree</SelectItem>
              <SelectItem value="clone">clone</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="label">
          Workspace 策略
          <Select value={draft.workspacePolicy} onValueChange={(v) => onChange({ workspacePolicy: v as ProjectManageDraft["workspacePolicy"] })} disabled={saving}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mount">mount（host 挂载）</SelectItem>
              <SelectItem value="git">git（guest clone/worktree）</SelectItem>
              <SelectItem value="empty">empty（空目录）</SelectItem>
              <SelectItem value="bundle">bundle（预置包）</SelectItem>
            </SelectContent>
          </Select>
          <div className="muted" style={{ marginTop: 6 }}>
            host 模式建议选 mount；guest 模式可选 git。
          </div>
        </label>

        {mode === "edit" ? (
          <label className="label">
            默认 Role Key（可选）
            <Input
              value={draft.defaultRoleKey}
              onChange={(e) => onChange({ defaultRoleKey: e.target.value })}
              disabled={saving}
              placeholder="例如：backend-dev（留空=清除）"
            />
          </label>
        ) : null}

        <details style={{ marginTop: 12 }}>
          <summary>Agent 工作区提示（可选）</summary>
          <div className="muted" style={{ marginTop: 6 }}>
            支持模板变量：<code>{"{{workspace}}"}</code> <code>{"{{branch}}"}</code> <code>{"{{repoUrl}}"}</code>{" "}
            <code>{"{{scmType}}"}</code> <code>{"{{defaultBranch}}"}</code> <code>{"{{baseBranch}}"}</code>。平台默认可通过{" "}
            <code>AGENT_WORKSPACE_NOTICE_TEMPLATE</code> 配置。
          </div>
          <label className="label">
            模式
            <Select
              value={draft.workspaceNoticeMode}
              disabled={saving}
              onValueChange={(v) => onChange({ workspaceNoticeMode: v as WorkspaceNoticeMode })}
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
          {draft.workspaceNoticeMode === "custom" ? (
            <label className="label">
              模板
              <Textarea
                value={draft.workspaceNoticeTemplate}
                disabled={saving}
                onChange={(e) => onChange({ workspaceNoticeTemplate: e.target.value })}
                rows={4}
                placeholder="例如：请在 {{workspace}} 中修改；若为 Git 仓库请 git commit。"
              />
            </label>
          ) : null}
        </details>

        <div className="muted" style={{ marginTop: 12 }}>
          Git/SCM 认证与配置已迁移到下方「凭证 / SCM 配置」面板；Role 的 envText 不负责 git 认证。
        </div>

        {!canSave ? (
          <div className="muted" style={{ marginTop: 10 }}>
            需要管理员权限才能{mode === "edit" ? "保存" : "创建"} Project。
          </div>
        ) : null}
      </form>
    </div>
  );
}

function GitCredentialEditor(props: {
  title: string;
  projectId: string;
  provider: string;
  credential: GitCredential;
  canSave: boolean;
  setError: (msg: string | null) => void;
  onSaved: () => Promise<void>;
}) {
  const { title, projectId, provider, credential, canSave, setError, onSaved } = props;

  const [saving, setSaving] = useState(false);
  const [gitAuthMode, setGitAuthMode] = useState<GitAuthMode>(credential.gitAuthMode);

  const [githubAccessToken, setGithubAccessToken] = useState("");
  const [githubAccessTokenClear, setGithubAccessTokenClear] = useState(false);
  const [gitlabAccessToken, setGitlabAccessToken] = useState("");
  const [gitlabAccessTokenClear, setGitlabAccessTokenClear] = useState(false);
  const [gitHttpUsername, setGitHttpUsername] = useState("");
  const [gitHttpUsernameClear, setGitHttpUsernameClear] = useState(false);
  const [gitHttpPassword, setGitHttpPassword] = useState("");
  const [gitHttpPasswordClear, setGitHttpPasswordClear] = useState(false);
  const [gitSshCommand, setGitSshCommand] = useState("");
  const [gitSshCommandClear, setGitSshCommandClear] = useState(false);
  const [gitSshKey, setGitSshKey] = useState("");
  const [gitSshKeyClear, setGitSshKeyClear] = useState(false);
  const [gitSshKeyB64, setGitSshKeyB64] = useState("");

  useEffect(() => {
    setGitAuthMode(credential.gitAuthMode);

    setGithubAccessToken("");
    setGithubAccessTokenClear(false);
    setGitlabAccessToken("");
    setGitlabAccessTokenClear(false);
    setGitHttpUsername(credential.gitHttpUsername ?? "");
    setGitHttpUsernameClear(false);
    setGitHttpPassword("");
    setGitHttpPasswordClear(false);
    setGitSshCommand("");
    setGitSshCommandClear(false);
    setGitSshKey("");
    setGitSshKeyClear(false);
    setGitSshKeyB64("");
  }, [credential.gitHttpUsername, credential.id, credential.gitAuthMode]);

  const supportsTokenAuth = provider === "github" || provider === "gitlab" || provider === "codeup";
  const showTokenFields = supportsTokenAuth && gitAuthMode === "https_pat";
  const showGithubToken = showTokenFields && provider === "github";
  const showGitlabToken = showTokenFields && (provider === "gitlab" || provider === "codeup");
  const showBasicAuth = gitAuthMode === "https_basic";
  const authModeOptions = useMemo(() => {
    const options: Array<{ value: GitAuthMode; label: string }> = supportsTokenAuth
      ? [
        { value: "https_pat", label: "HTTPS（Token）" },
        { value: "ssh", label: "SSH" },
      ]
      : [
        { value: "ssh", label: "SSH（推荐）" },
        { value: "https_basic", label: "HTTPS（用户名/密码）" },
      ];
    if (!options.some((opt) => opt.value === gitAuthMode)) {
      options.unshift({ value: gitAuthMode, label: `当前：${gitAuthMode}` });
    }
    return options;
  }, [gitAuthMode, supportsTokenAuth]);

  const patchSecret = (draft: string, clear: boolean): string | null | undefined => {
    if (clear) return null;
    const v = draft.trim();
    return v ? v : undefined;
  };

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      await updateGitCredential(projectId, credential.id, {
        gitAuthMode,
        ...(showGithubToken ? { githubAccessToken: patchSecret(githubAccessToken, githubAccessTokenClear) } : {}),
        ...(showGitlabToken ? { gitlabAccessToken: patchSecret(gitlabAccessToken, gitlabAccessTokenClear) } : {}),
        ...(showBasicAuth
          ? {
            gitHttpUsername: patchSecret(gitHttpUsername, gitHttpUsernameClear),
            gitHttpPassword: patchSecret(gitHttpPassword, gitHttpPasswordClear),
          }
          : {}),
        ...(gitAuthMode === "ssh"
          ? {
            gitSshCommand: patchSecret(gitSshCommand, gitSshCommandClear),
            gitSshKey: patchSecret(gitSshKey, gitSshKeyClear),
            gitSshKeyB64: gitSshKeyClear ? null : gitSshKeyB64.trim() ? gitSshKeyB64.trim() : undefined,
          }
          : {}),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [
    canSave,
    credential.id,
    gitAuthMode,
    gitSshCommand,
    gitSshCommandClear,
    gitSshKey,
    gitSshKeyB64,
    gitSshKeyClear,
    gitHttpPassword,
    gitHttpPasswordClear,
    gitHttpUsername,
    gitHttpUsernameClear,
    githubAccessToken,
    githubAccessTokenClear,
    gitlabAccessToken,
    gitlabAccessTokenClear,
    onSaved,
    projectId,
    setError,
    showBasicAuth,
    showGithubToken,
    showGitlabToken,
  ]);

  return (
    <div className="rounded-lg border bg-card p-4" style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div className="muted" style={{ marginTop: 4 }}>
        名称: <strong>{credential.displayName ?? credential.key}</strong> · key: <code>{credential.key}</code>
        {credential.purpose ? (
          <>
            {" "}
            purpose: <code>{credential.purpose}</code>
          </>
        ) : null}{" "}
        updatedAt: {credential.updatedAt ? new Date(credential.updatedAt).toLocaleString() : "—"}
      </div>

      <div className="form" style={{ marginTop: 10 }}>
        <label className="label">
          Git 认证
          <Select value={gitAuthMode} onValueChange={(v) => setGitAuthMode(v as GitAuthMode)} disabled={saving || !canSave}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {authModeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="muted" style={{ marginTop: 6 }}>
            {supportsTokenAuth
              ? "HTTPS（Token）仅支持 Token，不支持用户名密码。"
              : "普通 Git 推荐 SSH；如需 HTTP Basic 可使用用户名/密码。"}
          </div>
        </label>

        {showGithubToken ? (
          <label className="label">
            GitHub Access Token（留空=不改）
            <Input
              type="password"
              value={githubAccessToken}
              onChange={(e) => setGithubAccessToken(e.target.value)}
              placeholder={credential.hasGithubAccessToken ? "已设置（留空不改）" : "ghp_... / github_pat_..."}
              disabled={saving || !canSave || githubAccessTokenClear}
            />
            <span className="row gap" style={{ alignItems: "center" }}>
              <Checkbox checked={githubAccessTokenClear} onCheckedChange={(v) => setGithubAccessTokenClear(v === true)} disabled={saving || !canSave} />
              <span className="muted">清除 token</span>
            </span>
          </label>
        ) : null}

        {showGitlabToken ? (
          <label className="label">
            GitLab Access Token（留空=不改）
            <Input
              type="password"
              value={gitlabAccessToken}
              onChange={(e) => setGitlabAccessToken(e.target.value)}
              placeholder={credential.hasGitlabAccessToken ? "已设置（留空不改）" : "glpat-..."}
              disabled={saving || !canSave || gitlabAccessTokenClear}
            />
            <span className="row gap" style={{ alignItems: "center" }}>
              <Checkbox checked={gitlabAccessTokenClear} onCheckedChange={(v) => setGitlabAccessTokenClear(v === true)} disabled={saving || !canSave} />
              <span className="muted">清除 token</span>
            </span>
          </label>
        ) : null}

        {showBasicAuth ? (
          <>
            <label className="label">
              HTTP Basic 用户名（留空=不改）
              <Input
                value={gitHttpUsername}
                onChange={(e) => setGitHttpUsername(e.target.value)}
                placeholder="例如：git"
                disabled={saving || !canSave || gitHttpUsernameClear}
              />
              <span className="row gap" style={{ alignItems: "center" }}>
                <Checkbox checked={gitHttpUsernameClear} onCheckedChange={(v) => setGitHttpUsernameClear(v === true)} disabled={saving || !canSave} />
                <span className="muted">清除用户名</span>
              </span>
            </label>

            <label className="label">
              HTTP Basic 密码（留空=不改）
              <Input
                type="password"
                value={gitHttpPassword}
                onChange={(e) => setGitHttpPassword(e.target.value)}
                placeholder={credential.hasGitHttpPassword ? "已设置（留空不改）" : "输入密码或 Token"}
                disabled={saving || !canSave || gitHttpPasswordClear}
              />
              <span className="row gap" style={{ alignItems: "center" }}>
                <Checkbox checked={gitHttpPasswordClear} onCheckedChange={(v) => setGitHttpPasswordClear(v === true)} disabled={saving || !canSave} />
                <span className="muted">清除密码</span>
              </span>
            </label>
          </>
        ) : null}

        {gitAuthMode === "ssh" ? (
          <details style={{ marginTop: 10 }} open={credential.hasSshKey}>
            <summary>SSH 配置（可选）</summary>
            <label className="label">
              GIT_SSH_COMMAND（留空=不改）
              <Input
                value={gitSshCommand}
                onChange={(e) => setGitSshCommand(e.target.value)}
                placeholder="例如：ssh -o StrictHostKeyChecking=no"
                disabled={saving || !canSave || gitSshCommandClear}
              />
              <span className="row gap" style={{ alignItems: "center" }}>
                <Checkbox checked={gitSshCommandClear} onCheckedChange={(v) => setGitSshCommandClear(v === true)} disabled={saving || !canSave} />
                <span className="muted">清除 command</span>
              </span>
            </label>

            <label className="label">
              私钥（留空=不改）
              <Textarea
                value={gitSshKey}
                onChange={(e) => setGitSshKey(e.target.value)}
                rows={6}
                placeholder={credential.hasSshKey ? "已设置（留空不改）" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                disabled={saving || !canSave || gitSshKeyClear}
              />
              <span className="row gap" style={{ alignItems: "center" }}>
                <Checkbox checked={gitSshKeyClear} onCheckedChange={(v) => setGitSshKeyClear(v === true)} disabled={saving || !canSave} />
                <span className="muted">清除 SSH Key（含 b64）</span>
              </span>
            </label>

            <label className="label">
              私钥（base64，可选，留空=不改）
              <Input value={gitSshKeyB64} onChange={(e) => setGitSshKeyB64(e.target.value)} placeholder={credential.hasSshKey ? "已设置（留空不改）" : ""} disabled={saving || !canSave || gitSshKeyClear} />
            </label>
          </details>
        ) : null}

        <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <Button type="button" size="sm" onClick={() => void onSave()} disabled={saving || !canSave}>
            {saving ? "处理中…" : "保存凭证"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProjectIntegrationsPanel(props: {
  active: boolean;
  projectId: string;
  project: Project | null;
  canSave: boolean;
  setError: (msg: string | null) => void;
  onRefreshGlobal: () => Promise<void>;
}) {
  const { active, projectId, project, canSave, setError, onRefreshGlobal } = props;

  const provider = useMemo(() => (project?.scmType ?? "gitlab").toLowerCase(), [project?.scmType]);
  const supportsTokenAuth = provider === "github" || provider === "gitlab" || provider === "codeup";
  const defaultAuthMode: GitAuthMode = supportsTokenAuth ? "https_pat" : "ssh";
  const NO_CRED = "__none__";

  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [credentials, setCredentials] = useState<GitCredential[]>([]);

  const [scmConfigLoading, setScmConfigLoading] = useState(false);
  const [scmConfig, setScmConfig] = useState<ProjectScmConfig | null>(null);

  const [runDefaultId, setRunDefaultId] = useState<string>(NO_CRED);
  const [adminDefaultId, setAdminDefaultId] = useState<string>(NO_CRED);

  useEffect(() => {
    setRunDefaultId(project?.runGitCredentialId ?? NO_CRED);
    setAdminDefaultId(project?.scmAdminCredentialId ?? NO_CRED);
  }, [projectId, project?.runGitCredentialId, project?.scmAdminCredentialId]);

  const refreshCredentials = useCallback(async () => {
    setCredentialsLoading(true);
    try {
      const list = await listGitCredentials(projectId);
      setCredentials(list);
    } finally {
      setCredentialsLoading(false);
    }
  }, [projectId]);

  const refreshScmConfig = useCallback(async () => {
    setScmConfigLoading(true);
    try {
      const cfg = await getProjectScmConfig(projectId);
      setScmConfig(cfg);
    } finally {
      setScmConfigLoading(false);
    }
  }, [projectId]);

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      await Promise.all([refreshCredentials(), refreshScmConfig()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshCredentials, refreshScmConfig, setError]);

  useEffect(() => {
    if (!active) return;
    if (!projectId) return;
    void refreshAll();
  }, [active, projectId, refreshAll]);

  const runCredential = useMemo(
    () => (runDefaultId === NO_CRED ? null : credentials.find((c) => c.id === runDefaultId) ?? null),
    [credentials, runDefaultId],
  );
  const adminCredential = useMemo(
    () => (adminDefaultId === NO_CRED ? null : credentials.find((c) => c.id === adminDefaultId) ?? null),
    [adminDefaultId, credentials],
  );

  const [settingDefaults, setSettingDefaults] = useState(false);
  const onSetDefaults = useCallback(
    async (patch: { runGitCredentialId?: string | null; scmAdminCredentialId?: string | null }) => {
      if (!canSave) return;
      setError(null);
      setSettingDefaults(true);
      try {
        await setGitCredentialDefaults(projectId, patch);
        await onRefreshGlobal();
        await refreshAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingDefaults(false);
      }
    },
    [canSave, onRefreshGlobal, projectId, refreshAll, setError],
  );

  const [ensuringDefault, setEnsuringDefault] = useState<"run" | "scm_admin" | null>(null);
  const ensureDefaultCredential = useCallback(
    async (kind: "run" | "scm_admin") => {
      if (!canSave) return;
      setError(null);
      setEnsuringDefault(kind);
      try {
        const key = kind === "run" ? "run-default" : "scm-admin";
        const purpose = kind === "run" ? "run" : "scm_admin";
        const displayName = kind === "run" ? "Run 默认凭证" : "SCM Admin 默认凭证";
        let cred = credentials.find((c) => c.key === key) ?? null;
        if (!cred) {
          cred = await createGitCredential(projectId, { key, displayName, purpose, gitAuthMode: defaultAuthMode });
        }
        await onSetDefaults(kind === "run" ? { runGitCredentialId: cred.id } : { scmAdminCredentialId: cred.id });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setEnsuringDefault(null);
      }
    },
    [canSave, credentials, defaultAuthMode, onSetDefaults, projectId, setError],
  );

  const [scmGitlabProjectId, setScmGitlabProjectId] = useState("");
  const [scmGitlabWebhookSecret, setScmGitlabWebhookSecret] = useState("");
  const [scmGitlabWebhookSecretClear, setScmGitlabWebhookSecretClear] = useState(false);
  const [scmGithubPollingEnabled, setScmGithubPollingEnabled] = useState(false);

  useEffect(() => {
    if (!scmConfig) return;
    setScmGitlabProjectId(scmConfig.gitlabProjectId ? String(scmConfig.gitlabProjectId) : "");
    setScmGitlabWebhookSecret("");
    setScmGitlabWebhookSecretClear(false);
    setScmGithubPollingEnabled(Boolean(scmConfig.githubPollingEnabled));
  }, [scmConfig]);

  const [savingScmConfig, setSavingScmConfig] = useState(false);
  const onSaveScmConfig = useCallback(async () => {
    if (!canSave) return;
    setError(null);
    setSavingScmConfig(true);
    try {
      const input: { gitlabProjectId?: number | null; gitlabWebhookSecret?: string | null; githubPollingEnabled?: boolean } = {};

      if (provider === "gitlab" || provider === "codeup") {
        const raw = scmGitlabProjectId.trim();
        if (raw === "") {
          input.gitlabProjectId = null;
        } else {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            setError("GitLab Project ID 需要正整数（留空=清除）");
            return;
          }
          input.gitlabProjectId = parsed;
        }

        if (scmGitlabWebhookSecretClear) {
          input.gitlabWebhookSecret = null;
        } else {
          const secret = scmGitlabWebhookSecret.trim();
          if (secret) input.gitlabWebhookSecret = secret;
        }
      }

      if (provider === "github") {
        input.githubPollingEnabled = scmGithubPollingEnabled;
      }

      const next = await updateProjectScmConfig(projectId, input);
      setScmConfig(next);
      await onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingScmConfig(false);
    }
  }, [
    canSave,
    onRefreshGlobal,
    projectId,
    provider,
    scmGithubPollingEnabled,
    scmGitlabProjectId,
    scmGitlabWebhookSecret,
    scmGitlabWebhookSecretClear,
    setError,
  ]);

  const credentialOptions = useMemo(() => {
    return [
      { id: NO_CRED, label: "未设置" },
      ...credentials.map((c) => ({
        id: c.id,
        label: `${c.scope === "platform" ? "[公共] " : ""}${c.displayName ?? c.key} (${c.key})${c.purpose ? ` · ${c.purpose}` : ""}`,
      })),
    ];
  }, [credentials]);

  return (
    <div className="rounded-lg border bg-card p-4" style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 800 }}>凭证 / SCM 配置</div>
      <div className="muted" style={{ marginTop: 4 }}>
        Git 相关 secrets 已迁移到项目级凭证；Role 的 envText 不再负责 git 认证。
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>Git 凭证（低权限 Run）</summary>
        {credentialsLoading ? (
          <div className="muted" style={{ marginTop: 8 }}>
            加载中…
          </div>
        ) : (
          <>
            <div className="form" style={{ marginTop: 10 }}>
              <label className="label">
                默认凭证
                <Select
                  value={runDefaultId}
                  onValueChange={(v) => {
                    setRunDefaultId(v);
                    void onSetDefaults({ runGitCredentialId: v === NO_CRED ? null : v });
                  }}
                  disabled={settingDefaults || !canSave}
                >
                  <SelectTrigger className="w-[320px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {credentialOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <div className="row gap" style={{ flexWrap: "wrap" }}>
                <Button type="button" size="sm" variant="secondary" onClick={() => void ensureDefaultCredential("run")} disabled={ensuringDefault != null || !canSave}>
                  {ensuringDefault === "run" ? "处理中…" : "创建并设为默认（Run）"}
                </Button>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                如果没有默认 Run 凭证，将自动创建 key=run-default 并设为默认。
              </div>
            </div>

            {runCredential ? (
              <GitCredentialEditor
                title={runCredential.scope === "platform" ? "编辑默认 Run 凭证（公共）" : "编辑默认 Run 凭证"}
                projectId={projectId}
                provider={provider}
                credential={runCredential}
                canSave={canSave}
                setError={setError}
                onSaved={refreshAll}
              />
            ) : (
              <div className="muted" style={{ marginTop: 10 }}>
                未设置默认 Run 凭证。
              </div>
            )}
          </>
        )}
      </details>

      <details style={{ marginTop: 12 }}>
        <summary>SCM Admin 凭证（高权限）</summary>
        {credentialsLoading ? (
          <div className="muted" style={{ marginTop: 8 }}>
            加载中…
          </div>
        ) : (
          <>
            <div className="form" style={{ marginTop: 10 }}>
              <label className="label">
                默认凭证
                <Select
                  value={adminDefaultId}
                  onValueChange={(v) => {
                    setAdminDefaultId(v);
                    void onSetDefaults({ scmAdminCredentialId: v === NO_CRED ? null : v });
                  }}
                  disabled={settingDefaults || !canSave}
                >
                  <SelectTrigger className="w-[320px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {credentialOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <div className="row gap" style={{ flexWrap: "wrap" }}>
                <Button type="button" size="sm" variant="secondary" onClick={() => void ensureDefaultCredential("scm_admin")} disabled={ensuringDefault != null || !canSave}>
                  {ensuringDefault === "scm_admin" ? "处理中…" : "创建并设为默认（SCM Admin）"}
                </Button>
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                如果没有默认 SCM Admin 凭证，将自动创建 key=scm-admin 并设为默认。
              </div>
            </div>

            {adminCredential ? (
              <GitCredentialEditor
                title={adminCredential.scope === "platform" ? "编辑默认 SCM Admin 凭证（公共）" : "编辑默认 SCM Admin 凭证"}
                projectId={projectId}
                provider={provider}
                credential={adminCredential}
                canSave={canSave}
                setError={setError}
                onSaved={refreshAll}
              />
            ) : (
              <div className="muted" style={{ marginTop: 10 }}>
                未设置默认 SCM Admin 凭证。
              </div>
            )}
          </>
        )}
      </details>

      <details style={{ marginTop: 12 }}>
        <summary>SCM 配置</summary>
        {scmConfigLoading ? (
          <div className="muted" style={{ marginTop: 8 }}>
            加载中…
          </div>
        ) : (
          <div className="form" style={{ marginTop: 10 }}>
            {provider === "gitlab" || provider === "codeup" ? (
              <>
                <label className="label">
                  GitLab Project ID（留空=清除）
                  <Input value={scmGitlabProjectId} onChange={(e) => setScmGitlabProjectId(e.target.value)} placeholder="12345" disabled={savingScmConfig || !canSave} />
                </label>

                <label className="label">
                  GitLab Webhook Secret（留空=不改）
                  <Input
                    type="password"
                    value={scmGitlabWebhookSecret}
                    onChange={(e) => setScmGitlabWebhookSecret(e.target.value)}
                    placeholder={scmConfig?.hasGitlabWebhookSecret ? "已设置（留空不改）" : ""}
                    disabled={savingScmConfig || !canSave || scmGitlabWebhookSecretClear}
                  />
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox checked={scmGitlabWebhookSecretClear} onCheckedChange={(v) => setScmGitlabWebhookSecretClear(v === true)} disabled={savingScmConfig || !canSave} />
                    <span className="muted">清除 secret</span>
                  </span>
                </label>
              </>
            ) : null}

            {provider === "github" ? (
              <>
                <label className="label">
                  <span className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox checked={scmGithubPollingEnabled} onCheckedChange={(v) => setScmGithubPollingEnabled(v === true)} disabled={savingScmConfig || !canSave} />
                    启用 GitHub 轮询监听（每分钟导入 Issues/PR）
                  </span>
                </label>
                <div className="muted">上次同步：{scmConfig?.githubPollingCursor ? new Date(scmConfig.githubPollingCursor).toLocaleString() : "未同步"}</div>
              </>
            ) : null}

            <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <Button type="button" size="sm" onClick={() => void onSaveScmConfig()} disabled={savingScmConfig || !canSave}>
                {savingScmConfig ? "处理中…" : "保存 SCM 配置"}
              </Button>
            </div>
          </div>
        )}
      </details>
    </div>
  );
}

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

  const location = useLocation();
  const auth = useAuth();
  const canSave = auth.hasRole(["admin"]);

  const [manageTab, setManageTab] = useState<ManageMode>("edit");
  const [savingProjectEdit, setSavingProjectEdit] = useState(false);
  const [savingProjectCreate, setSavingProjectCreate] = useState(false);

  const [editName, setEditName] = useState("");
  const [editRepoUrl, setEditRepoUrl] = useState("");
  const [editScmType, setEditScmType] = useState("gitlab");
  const [editDefaultBranch, setEditDefaultBranch] = useState("main");
  const [editWorkspaceMode, setEditWorkspaceMode] = useState<"worktree" | "clone">("worktree");
  const [editWorkspacePolicy, setEditWorkspacePolicy] = useState<ProjectManageDraft["workspacePolicy"]>("git");
  const [editDefaultRoleKey, setEditDefaultRoleKey] = useState("");
  const [editWorkspaceNoticeMode, setEditWorkspaceNoticeMode] = useState<WorkspaceNoticeMode>("default");
  const [editWorkspaceNoticeTemplate, setEditWorkspaceNoticeTemplate] = useState("");

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [projectScmType, setProjectScmType] = useState("gitlab");
  const [projectDefaultBranch, setProjectDefaultBranch] = useState("main");
  const [projectWorkspaceMode, setProjectWorkspaceMode] = useState<"worktree" | "clone">("worktree");
  const [projectWorkspacePolicy, setProjectWorkspacePolicy] = useState<ProjectManageDraft["workspacePolicy"]>("git");
  const [projectAgentWorkspaceNoticeMode, setProjectAgentWorkspaceNoticeMode] = useState<WorkspaceNoticeMode>("default");
  const [projectAgentWorkspaceNoticeTemplate, setProjectAgentWorkspaceNoticeTemplate] = useState("");

  useEffect(() => {
    if (!active) return;
    if (loading) return;
    if (!projects.length) setManageTab("create");
  }, [active, loading, projects.length]);

  useEffect(() => {
    if (!active) return;
    const hash = location.hash || "";
    const id = hash.startsWith("#") ? hash.slice(1) : "";
    if (id !== "project-create") return;
    setManageTab("create");
    const t = setTimeout(() => {
      const el = document.getElementById("project-create");
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
    return () => clearTimeout(t);
  }, [active, location.hash]);

  useEffect(() => {
    if (!effectiveProject) return;
    setEditName(effectiveProject.name ?? "");
    setEditRepoUrl(effectiveProject.repoUrl ?? "");
    setEditScmType(effectiveProject.scmType ?? "gitlab");
    setEditDefaultBranch(effectiveProject.defaultBranch ?? "main");
    setEditWorkspaceMode(effectiveProject.workspaceMode ?? "worktree");
    setEditWorkspacePolicy((effectiveProject.workspacePolicy ?? "git") as ProjectManageDraft["workspacePolicy"]);
    setEditDefaultRoleKey(effectiveProject.defaultRoleKey ?? "");

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

  const onResetProjectEdit = useCallback(() => {
    if (!effectiveProject) return;
    setEditName(effectiveProject.name ?? "");
    setEditRepoUrl(effectiveProject.repoUrl ?? "");
    setEditScmType(effectiveProject.scmType ?? "gitlab");
    setEditDefaultBranch(effectiveProject.defaultBranch ?? "main");
    setEditWorkspaceMode(effectiveProject.workspaceMode ?? "worktree");
    setEditWorkspacePolicy((effectiveProject.workspacePolicy ?? "git") as ProjectManageDraft["workspacePolicy"]);
    setEditDefaultRoleKey(effectiveProject.defaultRoleKey ?? "");

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

  const onResetProjectCreate = useCallback(() => {
    setProjectName("");
    setProjectRepoUrl("");
    setProjectScmType("gitlab");
    setProjectDefaultBranch("main");
    setProjectWorkspaceMode("worktree");
    setProjectWorkspacePolicy("git");
    setProjectAgentWorkspaceNoticeMode("default");
    setProjectAgentWorkspaceNoticeTemplate("");
  }, []);

  const onCreateProject = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;

    setSavingProjectCreate(true);
    try {
      const p = await createProject({
        name: projectName.trim(),
        repoUrl: projectRepoUrl.trim(),
        scmType: projectScmType.trim() || undefined,
        defaultBranch: projectDefaultBranch.trim() || undefined,
        workspaceMode: projectWorkspaceMode,
        workspacePolicy: projectWorkspacePolicy,
        agentWorkspaceNoticeTemplate:
          projectAgentWorkspaceNoticeMode === "default"
            ? undefined
            : projectAgentWorkspaceNoticeMode === "hidden"
              ? ""
              : projectAgentWorkspaceNoticeTemplate,
      });

      onResetProjectCreate();
      await onRefreshGlobal();
      onSelectedProjectIdChange(p.id);
      setManageTab("edit");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProjectCreate(false);
    }
  }, [
    onRefreshGlobal,
    onResetProjectCreate,
    onSelectedProjectIdChange,
    projectAgentWorkspaceNoticeMode,
    projectAgentWorkspaceNoticeTemplate,
    projectDefaultBranch,
    projectName,
    projectRepoUrl,
    projectScmType,
    projectWorkspaceMode,
    projectWorkspacePolicy,
    requireAdmin,
    setError,
  ]);

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

    const agentWorkspaceNoticeTemplate =
      editWorkspaceNoticeMode === "default" ? null : editWorkspaceNoticeMode === "hidden" ? "" : editWorkspaceNoticeTemplate;

    setSavingProjectEdit(true);
    try {
      await updateProject(effectiveProjectId, {
        name,
        repoUrl,
        scmType: editScmType.trim() || undefined,
        defaultBranch: editDefaultBranch.trim() || undefined,
        workspaceMode: editWorkspaceMode,
        workspacePolicy: editWorkspacePolicy,
        defaultRoleKey: editDefaultRoleKey.trim() ? editDefaultRoleKey.trim() : null,
        agentWorkspaceNoticeTemplate,
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
    editName,
    editRepoUrl,
    editScmType,
    editWorkspaceMode,
    editWorkspacePolicy,
    editWorkspaceNoticeMode,
    editWorkspaceNoticeTemplate,
    effectiveProjectId,
    onRefreshGlobal,
    requireAdmin,
    setError,
  ]);

  const draft: ProjectManageDraft =
    manageTab === "edit"
      ? {
        name: editName,
        repoUrl: editRepoUrl,
        scmType: editScmType,
        defaultBranch: editDefaultBranch,
        workspaceMode: editWorkspaceMode,
        workspacePolicy: editWorkspacePolicy,
        defaultRoleKey: editDefaultRoleKey,
        workspaceNoticeMode: editWorkspaceNoticeMode,
        workspaceNoticeTemplate: editWorkspaceNoticeTemplate,
      }
      : {
        name: projectName,
        repoUrl: projectRepoUrl,
        scmType: projectScmType,
        defaultBranch: projectDefaultBranch,
        workspaceMode: projectWorkspaceMode,
        workspacePolicy: projectWorkspacePolicy,
        defaultRoleKey: "",
        workspaceNoticeMode: projectAgentWorkspaceNoticeMode,
        workspaceNoticeTemplate: projectAgentWorkspaceNoticeTemplate,
      };

  const onChangeDraft = useCallback(
    (patch: Partial<ProjectManageDraft>) => {
      if (manageTab === "edit") {
        if (patch.name !== undefined) setEditName(patch.name);
        if (patch.repoUrl !== undefined) setEditRepoUrl(patch.repoUrl);
        if (patch.scmType !== undefined) setEditScmType(patch.scmType);
        if (patch.defaultBranch !== undefined) setEditDefaultBranch(patch.defaultBranch);
        if (patch.workspaceMode !== undefined) setEditWorkspaceMode(patch.workspaceMode);
        if (patch.workspacePolicy !== undefined) setEditWorkspacePolicy(patch.workspacePolicy);
        if (patch.defaultRoleKey !== undefined) setEditDefaultRoleKey(patch.defaultRoleKey);
        if (patch.workspaceNoticeMode !== undefined) setEditWorkspaceNoticeMode(patch.workspaceNoticeMode);
        if (patch.workspaceNoticeTemplate !== undefined) setEditWorkspaceNoticeTemplate(patch.workspaceNoticeTemplate);
        return;
      }

      if (patch.name !== undefined) setProjectName(patch.name);
      if (patch.repoUrl !== undefined) setProjectRepoUrl(patch.repoUrl);
      if (patch.scmType !== undefined) setProjectScmType(patch.scmType);
      if (patch.defaultBranch !== undefined) setProjectDefaultBranch(patch.defaultBranch);
      if (patch.workspaceMode !== undefined) setProjectWorkspaceMode(patch.workspaceMode);
      if (patch.workspacePolicy !== undefined) setProjectWorkspacePolicy(patch.workspacePolicy);
      if (patch.workspaceNoticeMode !== undefined) setProjectAgentWorkspaceNoticeMode(patch.workspaceNoticeMode);
      if (patch.workspaceNoticeTemplate !== undefined) setProjectAgentWorkspaceNoticeTemplate(patch.workspaceNoticeTemplate);
    },
    [manageTab],
  );

  return (
    <>
      <section id="project-create" className="card" hidden={!active} style={{ marginBottom: 16 }}>
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>项目管理</h2>
            <div className="muted">编辑当前 Project，或创建新的 Project。</div>
          </div>
        </div>

        <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <Button
            type="button"
            size="sm"
            variant={manageTab === "edit" ? "default" : "secondary"}
            onClick={() => setManageTab("edit")}
            disabled={!projects.length || !effectiveProjectId}
          >
            编辑当前项目
          </Button>
          <Button type="button" size="sm" variant={manageTab === "create" ? "default" : "secondary"} onClick={() => setManageTab("create")}>
            创建新项目
          </Button>
        </div>

        <ProjectManageForm
          mode={manageTab}
          effectiveProjectId={effectiveProjectId}
          saving={manageTab === "edit" ? savingProjectEdit : savingProjectCreate}
          canSave={canSave}
          draft={draft}
          onChange={onChangeDraft}
          onReset={manageTab === "edit" ? onResetProjectEdit : onResetProjectCreate}
          onSubmit={manageTab === "edit" ? onSaveProjectEdit : onCreateProject}
        />

        {manageTab === "edit" ? (
          !effectiveProjectId ? (
            <div className="muted" style={{ marginTop: 10 }}>
              请先创建/选择 Project
            </div>
          ) : (
            <ProjectIntegrationsPanel
              active={active}
              projectId={effectiveProjectId}
              project={effectiveProject}
              canSave={canSave}
              setError={setError}
              onRefreshGlobal={onRefreshGlobal}
            />
          )
        ) : (
          <div className="muted" style={{ marginTop: 10 }}>
            创建 Project 后，再在「凭证 / SCM 配置」中配置 Git/SCM 相关信息。
          </div>
        )}
      </section>

      <section className="card" hidden={!active}>
        <h2 style={{ marginTop: 0, marginBottom: 4 }}>历史 Project 列表</h2>
        <div className="muted">点击即可切换当前 Project（也可在左侧下拉框切换）。</div>

        {loading ? (
          <div className="muted" style={{ marginTop: 10 }}>
            加载中…
          </div>
        ) : !projects.length ? (
          <div className="muted" style={{ marginTop: 10 }}>
            暂无 Project
          </div>
        ) : (
          <div style={{ marginTop: 10, overflowX: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>SCM</th>
                  <th>默认分支</th>
                  <th>Repo</th>
                  <th>创建时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => {
                  const activeRow = p.id === effectiveProjectId;
                  return (
                    <tr key={p.id} style={activeRow ? { background: "hsl(var(--muted) / 0.25)" } : undefined}>
                      <td style={{ fontWeight: activeRow ? 700 : 400 }}>{p.name}</td>
                      <td>{p.scmType}</td>
                      <td>{p.defaultBranch}</td>
                      <td style={{ maxWidth: 520 }} title={p.repoUrl}>
                        <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.repoUrl}</div>
                      </td>
                      <td className="muted">{p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}</td>
                      <td>
                        <Button type="button" variant="secondary" size="sm" onClick={() => onSelectedProjectIdChange(p.id)} disabled={activeRow}>
                          {activeRow ? "当前" : "切换"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
