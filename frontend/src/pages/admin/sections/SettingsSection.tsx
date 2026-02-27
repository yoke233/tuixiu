import { useCallback, useEffect, useState } from "react";

import {
  createPlatformGitCredential,
  createPlatformRole,
  deletePlatformGitCredential,
  deletePlatformRole,
  listPlatformGitCredentials,
  listPlatformRoles,
  updatePlatformGitCredential,
  updatePlatformRole,
} from "@/api/platformShared";
import type { GitAuthMode, GitCredential, RoleTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  active: boolean;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

function parsePositiveIntOrNull(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) return null;
  return value;
}

export function SettingsSection(props: Props) {
  const { active, requireAdmin, setError } = props;

  const [loading, setLoading] = useState(false);
  const [credentials, setCredentials] = useState<GitCredential[]>([]);
  const [roles, setRoles] = useState<RoleTemplate[]>([]);

  const [credDisplayName, setCredDisplayName] = useState("");
  const [credKey, setCredKey] = useState("");
  const [credPurpose, setCredPurpose] = useState("run");
  const [credAuthMode, setCredAuthMode] = useState<GitAuthMode>("https_pat");
  const [credGithubToken, setCredGithubToken] = useState("");
  const [credGitlabToken, setCredGitlabToken] = useState("");
  const [credHttpUsername, setCredHttpUsername] = useState("");
  const [credHttpPassword, setCredHttpPassword] = useState("");
  const [creatingCred, setCreatingCred] = useState(false);

  const [editingCredentialId, setEditingCredentialId] = useState("");
  const [editingCredDisplayName, setEditingCredDisplayName] = useState("");
  const [editingCredKey, setEditingCredKey] = useState("");
  const [editingCredPurpose, setEditingCredPurpose] = useState("");
  const [editingCredAuthMode, setEditingCredAuthMode] = useState<GitAuthMode>("https_pat");
  const [editingCredGithubToken, setEditingCredGithubToken] = useState("");
  const [editingCredGitlabToken, setEditingCredGitlabToken] = useState("");
  const [editingCredHttpUsername, setEditingCredHttpUsername] = useState("");
  const [editingCredHttpPassword, setEditingCredHttpPassword] = useState("");
  const [savingCredentialId, setSavingCredentialId] = useState("");

  const [roleKey, setRoleKey] = useState("");
  const [roleDisplayName, setRoleDisplayName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [rolePromptTemplate, setRolePromptTemplate] = useState("");
  const [roleInitScript, setRoleInitScript] = useState("");
  const [roleInitTimeoutSeconds, setRoleInitTimeoutSeconds] = useState("300");
  const [roleEnvText, setRoleEnvText] = useState("");
  const [creatingRole, setCreatingRole] = useState(false);

  const [editingRoleId, setEditingRoleId] = useState("");
  const [editingRoleDisplayName, setEditingRoleDisplayName] = useState("");
  const [editingRoleDescription, setEditingRoleDescription] = useState("");
  const [editingRolePromptTemplate, setEditingRolePromptTemplate] = useState("");
  const [editingRoleInitScript, setEditingRoleInitScript] = useState("");
  const [editingRoleInitTimeoutSeconds, setEditingRoleInitTimeoutSeconds] = useState("300");
  const [editingRoleEnvText, setEditingRoleEnvText] = useState("");
  const [savingRoleId, setSavingRoleId] = useState("");

  const refresh = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    setError(null);
    try {
      const [cs, rs] = await Promise.all([listPlatformGitCredentials(), listPlatformRoles()]);
      setCredentials(cs);
      setRoles(rs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [active, setError]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const onCreateCredential = useCallback(async () => {
    if (!requireAdmin()) return;

    const key = credKey.trim();
    const displayName = credDisplayName.trim() || key;
    if (!key) {
      setError("公共凭证 key 不能为空");
      return;
    }

    setCreatingCred(true);
    setError(null);
    try {
      await createPlatformGitCredential({
        key,
        displayName,
        purpose: credPurpose.trim() || undefined,
        gitAuthMode: credAuthMode,
        githubAccessToken: credGithubToken.trim() || undefined,
        gitlabAccessToken: credGitlabToken.trim() || undefined,
        gitHttpUsername: credHttpUsername.trim() || undefined,
        gitHttpPassword: credHttpPassword.trim() || undefined,
      });
      setCredDisplayName("");
      setCredKey("");
      setCredGithubToken("");
      setCredGitlabToken("");
      setCredHttpUsername("");
      setCredHttpPassword("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingCred(false);
    }
  }, [
    credAuthMode,
    credDisplayName,
    credGitlabToken,
    credGithubToken,
    credHttpPassword,
    credHttpUsername,
    credKey,
    credPurpose,
    refresh,
    requireAdmin,
    setError,
  ]);

  const startEditCredential = useCallback((credential: GitCredential) => {
    setEditingCredentialId(credential.id);
    setEditingCredDisplayName(credential.displayName ?? credential.key);
    setEditingCredKey(credential.key);
    setEditingCredPurpose(credential.purpose ?? "");
    setEditingCredAuthMode(credential.gitAuthMode);
    setEditingCredGithubToken("");
    setEditingCredGitlabToken("");
    setEditingCredHttpUsername(credential.gitHttpUsername ?? "");
    setEditingCredHttpPassword("");
  }, []);

  const cancelEditCredential = useCallback(() => {
    setEditingCredentialId("");
    setEditingCredDisplayName("");
    setEditingCredKey("");
    setEditingCredPurpose("");
    setEditingCredAuthMode("https_pat");
    setEditingCredGithubToken("");
    setEditingCredGitlabToken("");
    setEditingCredHttpUsername("");
    setEditingCredHttpPassword("");
    setSavingCredentialId("");
  }, []);

  const saveEditingCredential = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!editingCredentialId) return;

    const key = editingCredKey.trim();
    const displayName = editingCredDisplayName.trim();
    if (!key) {
      setError("公共凭证 key 不能为空");
      return;
    }
    if (!displayName) {
      setError("公共凭证显示名称不能为空");
      return;
    }

    setSavingCredentialId(editingCredentialId);
    setError(null);
    try {
      await updatePlatformGitCredential(editingCredentialId, {
        key,
        displayName,
        purpose: editingCredPurpose.trim() || null,
        gitAuthMode: editingCredAuthMode,
        githubAccessToken: editingCredGithubToken.trim() || undefined,
        gitlabAccessToken: editingCredGitlabToken.trim() || undefined,
        gitHttpUsername: editingCredHttpUsername.trim() || null,
        gitHttpPassword: editingCredHttpPassword.trim() || undefined,
      });
      cancelEditCredential();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingCredentialId("");
    }
  }, [
    cancelEditCredential,
    editingCredAuthMode,
    editingCredDisplayName,
    editingCredGitlabToken,
    editingCredGithubToken,
    editingCredHttpPassword,
    editingCredHttpUsername,
    editingCredKey,
    editingCredPurpose,
    editingCredentialId,
    refresh,
    requireAdmin,
    setError,
  ]);

  const onDeleteCredential = useCallback(
    async (credential: GitCredential) => {
      if (!requireAdmin()) return;
      if (!window.confirm(`确认删除公共凭证？\n\n${credential.displayName ?? credential.key} (${credential.key})`)) return;

      setError(null);
      try {
        await deletePlatformGitCredential(credential.id);
        if (editingCredentialId === credential.id) cancelEditCredential();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [cancelEditCredential, editingCredentialId, refresh, requireAdmin, setError],
  );

  const onCreateRole = useCallback(async () => {
    if (!requireAdmin()) return;

    const key = roleKey.trim();
    const displayName = roleDisplayName.trim();
    if (!key || !displayName) {
      setError("公共角色 key 和显示名称不能为空");
      return;
    }

    const timeoutSeconds = parsePositiveIntOrNull(roleInitTimeoutSeconds || "300");
    if (!timeoutSeconds) {
      setError("Init 超时必须为正整数（秒）");
      return;
    }

    setCreatingRole(true);
    setError(null);
    try {
      await createPlatformRole({
        key,
        displayName,
        description: roleDescription.trim() || undefined,
        promptTemplate: rolePromptTemplate.trim() || undefined,
        initScript: roleInitScript.trim() || undefined,
        initTimeoutSeconds: timeoutSeconds,
        envText: roleEnvText.trim() ? roleEnvText : undefined,
      });
      setRoleKey("");
      setRoleDisplayName("");
      setRoleDescription("");
      setRolePromptTemplate("");
      setRoleInitScript("");
      setRoleInitTimeoutSeconds("300");
      setRoleEnvText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRole(false);
    }
  }, [
    refresh,
    requireAdmin,
    roleDescription,
    roleDisplayName,
    roleEnvText,
    roleInitScript,
    roleInitTimeoutSeconds,
    roleKey,
    rolePromptTemplate,
    setError,
  ]);

  const startEditRole = useCallback((role: RoleTemplate) => {
    setEditingRoleId(role.id);
    setEditingRoleDisplayName(role.displayName ?? role.key);
    setEditingRoleDescription(role.description ?? "");
    setEditingRolePromptTemplate(role.promptTemplate ?? "");
    setEditingRoleInitScript(role.initScript ?? "");
    setEditingRoleInitTimeoutSeconds(String(role.initTimeoutSeconds || 300));
    setEditingRoleEnvText(role.envText ?? "");
  }, []);

  const cancelEditRole = useCallback(() => {
    setEditingRoleId("");
    setEditingRoleDisplayName("");
    setEditingRoleDescription("");
    setEditingRolePromptTemplate("");
    setEditingRoleInitScript("");
    setEditingRoleInitTimeoutSeconds("300");
    setEditingRoleEnvText("");
    setSavingRoleId("");
  }, []);

  const saveEditingRole = useCallback(async () => {
    if (!requireAdmin()) return;
    if (!editingRoleId) return;

    const displayName = editingRoleDisplayName.trim();
    if (!displayName) {
      setError("公共角色显示名称不能为空");
      return;
    }

    const timeoutSeconds = parsePositiveIntOrNull(editingRoleInitTimeoutSeconds || "300");
    if (!timeoutSeconds) {
      setError("Init 超时必须为正整数（秒）");
      return;
    }

    setSavingRoleId(editingRoleId);
    setError(null);
    try {
      await updatePlatformRole(editingRoleId, {
        displayName,
        description: editingRoleDescription.trim(),
        promptTemplate: editingRolePromptTemplate.trim(),
        initScript: editingRoleInitScript.trim(),
        initTimeoutSeconds: timeoutSeconds,
        envText: editingRoleEnvText,
      });
      cancelEditRole();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRoleId("");
    }
  }, [
    cancelEditRole,
    editingRoleDescription,
    editingRoleDisplayName,
    editingRoleEnvText,
    editingRoleId,
    editingRoleInitScript,
    editingRoleInitTimeoutSeconds,
    editingRolePromptTemplate,
    refresh,
    requireAdmin,
    setError,
  ]);

  const onDeleteRole = useCallback(
    async (role: RoleTemplate) => {
      if (!requireAdmin()) return;
      if (!window.confirm(`确认删除公共角色？\n\n${role.displayName} (${role.key})`)) return;

      setError(null);
      try {
        await deletePlatformRole(role.id);
        if (editingRoleId === role.id) cancelEditRole();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [cancelEditRole, editingRoleId, refresh, requireAdmin, setError],
  );

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <h2 style={{ marginTop: 0 }}>平台公共配置</h2>
      <div className="muted" style={{ marginBottom: 10 }}>
        在这里维护可跨项目复用的公共 Git 凭证与角色模板。项目可在「项目配置」或 Run 启动时直接选择。
      </div>

      <div className="rounded-lg border bg-card p-4" style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 800 }}>公共 Git 凭证</div>
        <div className="muted" style={{ marginTop: 4 }}>
          可维护多套公共凭证。建议使用“显示名称 + key”组合：显示名称用于页面可读性，key 用于脚本与配置引用。
        </div>

        <div className="form" style={{ marginTop: 10 }}>
          <label className="label">
            显示名称 *
            <Input
              value={credDisplayName}
              onChange={(e) => setCredDisplayName(e.target.value)}
              placeholder="GitHub 成员凭证"
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            key *
            <Input
              value={credKey}
              onChange={(e) => setCredKey(e.target.value)}
              placeholder="github-member"
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            purpose
            <Input
              value={credPurpose}
              onChange={(e) => setCredPurpose(e.target.value)}
              placeholder="run / scm_admin"
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            Git 认证
            <Select
              value={credAuthMode}
              onValueChange={(v) => setCredAuthMode(v as GitAuthMode)}
              disabled={creatingCred || loading}
            >
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="https_pat">HTTPS（Token）</SelectItem>
                <SelectItem value="https_basic">HTTPS（用户名/密码）</SelectItem>
                <SelectItem value="ssh">SSH</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="label">
            GitHub Token（可选）
            <Input
              type="password"
              value={credGithubToken}
              onChange={(e) => setCredGithubToken(e.target.value)}
              placeholder="ghp_..."
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            GitLab Token（可选）
            <Input
              type="password"
              value={credGitlabToken}
              onChange={(e) => setCredGitlabToken(e.target.value)}
              placeholder="glpat-..."
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            HTTP 用户名（可选）
            <Input
              value={credHttpUsername}
              onChange={(e) => setCredHttpUsername(e.target.value)}
              placeholder="例如：git / x-access-token"
              disabled={creatingCred || loading}
            />
          </label>

          <label className="label">
            HTTP 密码（可选）
            <Input
              type="password"
              value={credHttpPassword}
              onChange={(e) => setCredHttpPassword(e.target.value)}
              placeholder="可填密码或 token"
              disabled={creatingCred || loading}
            />
          </label>

          <div className="row gap" style={{ marginTop: 10 }}>
            <Button type="button" size="sm" onClick={() => void onCreateCredential()} disabled={creatingCred || loading}>
              {creatingCred ? "创建中…" : "新增公共凭证"}
            </Button>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          {credentials.length === 0 ? (
            <div className="muted">暂无公共凭证。</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {credentials.map((c) => (
                <div key={c.id} className="rounded border p-3">
                  <div className="row spaceBetween" style={{ flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{c.displayName ?? c.key}</div>
                      <div className="muted" style={{ marginTop: 2 }}>
                        key: <code>{c.key}</code>
                        {c.purpose ? (
                          <>
                            {" "}
                            · purpose: <code>{c.purpose}</code>
                          </>
                        ) : null}
                      </div>
                      <div className="muted" style={{ marginTop: 2 }}>
                        {c.gitAuthMode} · GH:{c.hasGithubAccessToken ? "已配" : "未配"} · GL:
                        {c.hasGitlabAccessToken ? "已配" : "未配"} · HTTP:
                        {c.gitHttpUsername ? `${c.gitHttpUsername}/${c.hasGitHttpPassword ? "****" : "未配密码"}` : "未配"}
                      </div>
                    </div>
                    <div className="row gap" style={{ flexWrap: "wrap" }}>
                      <Button type="button" size="sm" variant="secondary" onClick={() => startEditCredential(c)}>
                        编辑
                      </Button>
                      <Button type="button" size="sm" variant="destructive" onClick={() => void onDeleteCredential(c)}>
                        删除
                      </Button>
                    </div>
                  </div>

                  {editingCredentialId === c.id ? (
                    <div className="form" style={{ marginTop: 10 }}>
                      <label className="label">
                        显示名称 *
                        <Input
                          value={editingCredDisplayName}
                          onChange={(e) => setEditingCredDisplayName(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        key *
                        <Input
                          value={editingCredKey}
                          onChange={(e) => setEditingCredKey(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        purpose
                        <Input
                          value={editingCredPurpose}
                          onChange={(e) => setEditingCredPurpose(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        Git 认证
                        <Select
                          value={editingCredAuthMode}
                          onValueChange={(v) => setEditingCredAuthMode(v as GitAuthMode)}
                          disabled={savingCredentialId === c.id}
                        >
                          <SelectTrigger className="w-[220px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="https_pat">HTTPS（Token）</SelectItem>
                            <SelectItem value="https_basic">HTTPS（用户名/密码）</SelectItem>
                            <SelectItem value="ssh">SSH</SelectItem>
                          </SelectContent>
                        </Select>
                      </label>

                      <label className="label">
                        GitHub Token（可选，留空不改）
                        <Input
                          type="password"
                          value={editingCredGithubToken}
                          onChange={(e) => setEditingCredGithubToken(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        GitLab Token（可选，留空不改）
                        <Input
                          type="password"
                          value={editingCredGitlabToken}
                          onChange={(e) => setEditingCredGitlabToken(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        HTTP 用户名（可选，留空=清空）
                        <Input
                          value={editingCredHttpUsername}
                          onChange={(e) => setEditingCredHttpUsername(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>
                      <label className="label">
                        HTTP 密码（可选，留空不改）
                        <Input
                          type="password"
                          value={editingCredHttpPassword}
                          onChange={(e) => setEditingCredHttpPassword(e.target.value)}
                          disabled={savingCredentialId === c.id}
                        />
                      </label>

                      <div className="row gap" style={{ marginTop: 8 }}>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void saveEditingCredential()}
                          disabled={savingCredentialId === c.id}
                        >
                          {savingCredentialId === c.id ? "保存中…" : "保存"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={cancelEditCredential}
                          disabled={savingCredentialId === c.id}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4" style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 800 }}>公共角色模板</div>
        <div className="muted" style={{ marginTop: 4 }}>
          项目未定义同名角色时，将自动回退到这里的公共角色。这里支持完整编辑角色配置。
        </div>

        <div className="form" style={{ marginTop: 10 }}>
          <label className="label">
            key *
            <Input
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
              placeholder="member-dev"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            显示名称 *
            <Input
              value={roleDisplayName}
              onChange={(e) => setRoleDisplayName(e.target.value)}
              placeholder="成员开发"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            说明（可选）
            <Input
              value={roleDescription}
              onChange={(e) => setRoleDescription(e.target.value)}
              placeholder="该角色主要负责实现与修复"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            Prompt（可选）
            <Textarea
              value={rolePromptTemplate}
              onChange={(e) => setRolePromptTemplate(e.target.value)}
              rows={4}
              placeholder="你是成员开发角色，优先修复问题并补测试。"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            Init 脚本（可选）
            <Textarea
              value={roleInitScript}
              onChange={(e) => setRoleInitScript(e.target.value)}
              rows={4}
              placeholder="echo prepare && pnpm install"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            Init 超时（秒）
            <Input
              value={roleInitTimeoutSeconds}
              onChange={(e) => setRoleInitTimeoutSeconds(e.target.value)}
              placeholder="300"
              disabled={creatingRole || loading}
            />
          </label>
          <label className="label">
            envText（可选，.env 格式）
            <Textarea
              value={roleEnvText}
              onChange={(e) => setRoleEnvText(e.target.value)}
              rows={4}
              placeholder="FOO=bar"
              disabled={creatingRole || loading}
            />
          </label>

          <div className="row gap" style={{ marginTop: 10 }}>
            <Button type="button" size="sm" onClick={() => void onCreateRole()} disabled={creatingRole || loading}>
              {creatingRole ? "创建中…" : "新增公共角色"}
            </Button>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          {roles.length === 0 ? (
            <div className="muted">暂无公共角色。</div>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {roles.map((r) => (
                <div key={r.id} className="rounded border p-3">
                  <div className="row spaceBetween" style={{ flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{r.displayName ?? r.key}</div>
                      <div className="muted" style={{ marginTop: 2 }}>
                        key: <code>{r.key}</code> · initTimeoutSeconds: {r.initTimeoutSeconds}
                      </div>
                      {r.description ? <div className="muted" style={{ marginTop: 2 }}>{r.description}</div> : null}
                    </div>
                    <div className="row gap" style={{ flexWrap: "wrap" }}>
                      <Button type="button" size="sm" variant="secondary" onClick={() => startEditRole(r)}>
                        编辑
                      </Button>
                      <Button type="button" size="sm" variant="destructive" onClick={() => void onDeleteRole(r)}>
                        删除
                      </Button>
                    </div>
                  </div>

                  {editingRoleId === r.id ? (
                    <div className="form" style={{ marginTop: 10 }}>
                      <label className="label">
                        显示名称 *
                        <Input
                          value={editingRoleDisplayName}
                          onChange={(e) => setEditingRoleDisplayName(e.target.value)}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <label className="label">
                        说明（可选）
                        <Input
                          value={editingRoleDescription}
                          onChange={(e) => setEditingRoleDescription(e.target.value)}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <label className="label">
                        Prompt（可选）
                        <Textarea
                          value={editingRolePromptTemplate}
                          onChange={(e) => setEditingRolePromptTemplate(e.target.value)}
                          rows={4}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <label className="label">
                        Init 脚本（可选）
                        <Textarea
                          value={editingRoleInitScript}
                          onChange={(e) => setEditingRoleInitScript(e.target.value)}
                          rows={4}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <label className="label">
                        Init 超时（秒）
                        <Input
                          value={editingRoleInitTimeoutSeconds}
                          onChange={(e) => setEditingRoleInitTimeoutSeconds(e.target.value)}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <label className="label">
                        envText（可选，.env 格式）
                        <Textarea
                          value={editingRoleEnvText}
                          onChange={(e) => setEditingRoleEnvText(e.target.value)}
                          rows={4}
                          disabled={savingRoleId === r.id}
                        />
                      </label>

                      <div className="row gap" style={{ marginTop: 8 }}>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void saveEditingRole()}
                          disabled={savingRoleId === r.id}
                        >
                          {savingRoleId === r.id ? "保存中…" : "保存"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={cancelEditRole}
                          disabled={savingRoleId === r.id}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
