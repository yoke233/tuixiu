import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRole, deleteRole, listRoles, updateRole } from "../../../api/roles";
import type { RoleTemplate } from "../../../types";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

export function RolesSection(props: Props) {
  const { active, effectiveProjectId, requireAdmin, setError } = props;

  const roleCreateKeyRef = useRef<HTMLInputElement>(null);
  const [roleKey, setRoleKey] = useState("");
  const [roleDisplayName, setRoleDisplayName] = useState("");
  const [rolePromptTemplate, setRolePromptTemplate] = useState("");
  const [roleInitScript, setRoleInitScript] = useState("");
  const [roleInitTimeoutSeconds, setRoleInitTimeoutSeconds] = useState("300");
  const [roleEnvText, setRoleEnvText] = useState("");

  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);

  const [roleEditingId, setRoleEditingId] = useState("");
  const [roleEditDisplayName, setRoleEditDisplayName] = useState("");
  const [roleEditDescription, setRoleEditDescription] = useState("");
  const [roleEditPromptTemplate, setRoleEditPromptTemplate] = useState("");
  const [roleEditInitScript, setRoleEditInitScript] = useState("");
  const [roleEditInitTimeoutSeconds, setRoleEditInitTimeoutSeconds] = useState("");
  const [roleEditEnvTextEnabled, setRoleEditEnvTextEnabled] = useState(false);
  const [roleEditEnvText, setRoleEditEnvText] = useState("");
  const [roleSavingId, setRoleSavingId] = useState("");
  const [roleDeletingId, setRoleDeletingId] = useState("");

  const editingRole = useMemo(() => roles.find((role) => role.id === roleEditingId) ?? null, [roleEditingId, roles]);

  const resetRoleEdit = useCallback(() => {
    setRoleEditingId("");
    setRoleEditDisplayName("");
    setRoleEditDescription("");
    setRoleEditPromptTemplate("");
    setRoleEditInitScript("");
    setRoleEditInitTimeoutSeconds("");
    setRoleEditEnvTextEnabled(false);
    setRoleEditEnvText("");
  }, []);

  const refreshRoles = useCallback(async () => {
    if (!effectiveProjectId) return;
    setRolesLoading(true);
    setRolesError(null);
    try {
      const items = await listRoles(effectiveProjectId);
      setRoles(items);
    } catch (e) {
      setRolesError(e instanceof Error ? e.message : String(e));
    } finally {
      setRolesLoading(false);
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    if (!active) {
      resetRoleEdit();
      return;
    }
    resetRoleEdit();
    void refreshRoles();
  }, [active, refreshRoles, resetRoleEdit]);

  const startRoleEdit = useCallback((role: RoleTemplate) => {
    setRoleEditingId(role.id);
    setRoleEditDisplayName(role.displayName ?? "");
    setRoleEditDescription(role.description ?? "");
    setRoleEditPromptTemplate(role.promptTemplate ?? "");
    setRoleEditInitScript(role.initScript ?? "");
    setRoleEditInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
    setRoleEditEnvTextEnabled(false);
    setRoleEditEnvText(role.envText ?? "");
  }, []);

  const copyRoleToCreate = useCallback((role: RoleTemplate) => {
    setRoleKey("");
    setRoleDisplayName(role.displayName ?? "");
    setRolePromptTemplate(role.promptTemplate ?? "");
    setRoleInitScript(role.initScript ?? "");
    setRoleInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
    setRoleEnvText(role.envText ?? "");
    queueMicrotask(() => roleCreateKeyRef.current?.focus());
  }, []);

  const onCreateRole = useCallback(
    async (e: React.FormEvent) => {
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
          envText: roleEnvText.trim() || undefined,
          initTimeoutSeconds: Number(roleInitTimeoutSeconds) || undefined,
        });
        setRoleKey("");
        setRoleDisplayName("");
        setRolePromptTemplate("");
        setRoleInitScript("");
        setRoleInitTimeoutSeconds("300");
        setRoleEnvText("");
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      effectiveProjectId,
      refreshRoles,
      requireAdmin,
      roleDisplayName,
      roleEnvText,
      roleInitScript,
      roleInitTimeoutSeconds,
      roleKey,
      rolePromptTemplate,
      setError,
    ],
  );

  const onUpdateRole = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }
      if (!roleEditingId) return;

      const displayName = roleEditDisplayName.trim();
      if (!displayName) {
        setError("显示名称不能为空");
        return;
      }

      const timeoutRaw = roleEditInitTimeoutSeconds.trim();
      let timeoutSeconds: number | undefined;
      if (timeoutRaw) {
        const parsed = Number(timeoutRaw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setError("init 超时秒数需要正整数");
          return;
        }
        timeoutSeconds = parsed;
      }

      setRoleSavingId(roleEditingId);
      try {
        await updateRole(effectiveProjectId, roleEditingId, {
          displayName,
          description: roleEditDescription.trim(),
          promptTemplate: roleEditPromptTemplate.trim(),
          initScript: roleEditInitScript.trim(),
          ...(roleEditEnvTextEnabled ? { envText: roleEditEnvText } : {}),
          initTimeoutSeconds: timeoutSeconds,
        });
        resetRoleEdit();
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRoleSavingId("");
      }
    },
    [
      effectiveProjectId,
      refreshRoles,
      requireAdmin,
      resetRoleEdit,
      roleEditDescription,
      roleEditDisplayName,
      roleEditEnvText,
      roleEditEnvTextEnabled,
      roleEditingId,
      roleEditInitScript,
      roleEditInitTimeoutSeconds,
      roleEditPromptTemplate,
      setError,
    ],
  );

  const onDeleteRole = useCallback(
    async (role: RoleTemplate) => {
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }
      if (!window.confirm(`确认删除 RoleTemplate？\n\n${role.displayName} (${role.key})`)) return;

      setRoleDeletingId(role.id);
      try {
        await deleteRole(effectiveProjectId, role.id);
        if (roleEditingId === role.id) resetRoleEdit();
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRoleDeletingId("");
      }
    },
    [effectiveProjectId, refreshRoles, requireAdmin, resetRoleEdit, roleEditingId, setError],
  );

  return (
    <>
      <section className="card" hidden={!active}>
        <h2 style={{ marginTop: 0 }}>创建 RoleTemplate</h2>
        <form onSubmit={(e) => void onCreateRole(e)} className="form">
          <label className="label">
            Role Key *
            <input ref={roleCreateKeyRef} value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="backend-dev" />
          </label>
          <label className="label">
            显示名称 *
            <input value={roleDisplayName} onChange={(e) => setRoleDisplayName(e.target.value)} placeholder="后端开发" />
          </label>
          <label className="label">
            Prompt Template（可选）
            <textarea value={rolePromptTemplate} onChange={(e) => setRolePromptTemplate(e.target.value)} placeholder="你是 {{role.name}}，请优先写单测。" />
          </label>
          <label className="label">
            initScript（bash，可选）
            <textarea value={roleInitScript} onChange={(e) => setRoleInitScript(e.target.value)} placeholder={"# 可使用环境变量：GH_TOKEN/TUIXIU_WORKSPACE 等\n\necho init"} />
          </label>
          <label className="label">
            init 超时秒数（可选）
            <input value={roleInitTimeoutSeconds} onChange={(e) => setRoleInitTimeoutSeconds(e.target.value)} placeholder="300" />
          </label>
          <label className="label">
            envText（.env，可选）
            <textarea value={roleEnvText} onChange={(e) => setRoleEnvText(e.target.value)} rows={4} placeholder={"FOO=bar\nexport TOKEN=xxx"} />
          </label>
          <button type="submit" disabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}>
            创建
          </button>
        </form>
        {!effectiveProjectId ? <div className="muted">请先创建 Project</div> : null}
        <div className="muted" style={{ marginTop: 8 }}>
          initScript 默认在 workspace 执行；建议把持久内容写到 <code>$HOME/.tuixiu/projects/&lt;projectId&gt;</code>。
          <br />
          envText 仅在携带 admin 凭证时返回；请避免在其中存放不必要的敏感信息。
        </div>
      </section>

      <section className="card" hidden={!active}>
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ marginTop: 0 }}>已创建角色</h2>
            <div className="muted">维护 Prompt / initScript / 超时等配置。</div>
          </div>
          <button type="button" className="buttonSecondary" onClick={() => void refreshRoles()} disabled={!effectiveProjectId || rolesLoading}>
            刷新
          </button>
        </div>

        {!effectiveProjectId ? (
          <div className="muted">请先创建 Project</div>
        ) : rolesLoading ? (
          <div className="muted" style={{ marginTop: 10 }}>
            加载中…
          </div>
        ) : rolesError ? (
          <div className="muted" style={{ marginTop: 10 }} title={rolesError}>
            角色列表加载失败：{rolesError}
          </div>
        ) : roles.length ? (
          <div className="tableScroll" style={{ marginTop: 10 }}>
            <table className="table tableWrap">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>显示名称</th>
                  <th>init 超时</th>
                  <th>更新时间</th>
                  <th style={{ textAlign: "right" }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => {
                  const editing = roleEditingId === role.id;
                  const busy = roleSavingId === role.id || roleDeletingId === role.id;
                  return (
                    <tr key={role.id}>
                      <td>
                        <code title={role.key}>{role.key}</code>
                      </td>
                      <td>
                        <div className="cellStack">
                          <div>{role.displayName}</div>
                          {role.description ? <div className="cellSub">{role.description}</div> : null}
                          {role.envKeys?.length ? <div className="cellSub">env: {role.envKeys.join(", ")}</div> : null}
                        </div>
                      </td>
                      <td>{role.initTimeoutSeconds}s</td>
                      <td>{new Date(role.updatedAt).toLocaleString()}</td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row gap" style={{ justifyContent: "flex-end" }}>
                          <button type="button" className="buttonSecondary" onClick={() => copyRoleToCreate(role)} disabled={rolesLoading || busy} title="复制到上方创建表单（不填 key）">
                            复制
                          </button>
                          <button type="button" className="buttonSecondary" onClick={() => (editing ? resetRoleEdit() : startRoleEdit(role))} disabled={rolesLoading || busy}>
                            {editing ? "取消编辑" : "编辑"}
                          </button>
                          <button type="button" className="buttonSecondary" onClick={() => void onDeleteRole(role)} disabled={rolesLoading || roleDeletingId === role.id}>
                            {roleDeletingId === role.id ? "删除中…" : "删除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted" style={{ marginTop: 10 }}>
            暂无 RoleTemplate
          </div>
        )}

        {editingRole ? (
          <form onSubmit={(e) => void onUpdateRole(e)} className="form" style={{ marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>编辑角色</h3>
            <div className="muted">
              key: <code>{editingRole.key}</code> · id: <code>{editingRole.id}</code>
            </div>
            <label className="label">
              显示名称 *
              <input value={roleEditDisplayName} onChange={(e) => setRoleEditDisplayName(e.target.value)} />
            </label>
            <label className="label">
              描述（可选）
              <input value={roleEditDescription} onChange={(e) => setRoleEditDescription(e.target.value)} />
            </label>
            <label className="label">
              Prompt Template（可选）
              <textarea value={roleEditPromptTemplate} onChange={(e) => setRoleEditPromptTemplate(e.target.value)} />
            </label>
            <label className="label">
              initScript（bash，可选）
              <textarea value={roleEditInitScript} onChange={(e) => setRoleEditInitScript(e.target.value)} />
            </label>
            <label className="label">
              init 超时秒数（可选）
              <input value={roleEditInitTimeoutSeconds} onChange={(e) => setRoleEditInitTimeoutSeconds(e.target.value)} placeholder="300" />
            </label>
            <label className="label">
              envText（仅 admin，可选）
              <div className="row gap" style={{ alignItems: "center" }}>
                <input type="checkbox" checked={roleEditEnvTextEnabled} onChange={(e) => setRoleEditEnvTextEnabled(e.target.checked)} />
                <div className="muted">
                  勾选后允许编辑并保存（留空=清空）。
                  {editingRole.envKeys?.length ? ` 当前 keys: ${editingRole.envKeys.join(", ")}` : ""}
                </div>
              </div>
              <textarea value={roleEditEnvText} onChange={(e) => setRoleEditEnvText(e.target.value)} rows={4} readOnly={!roleEditEnvTextEnabled} placeholder={"FOO=bar\nexport TOKEN=xxx"} />
            </label>
            <div className="row gap" style={{ marginTop: 10 }}>
              <button type="submit" disabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}>
                {roleSavingId === editingRole.id ? "保存中…" : "保存修改"}
              </button>
              <button type="button" className="buttonSecondary" onClick={resetRoleEdit}>
                取消
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </>
  );
}

