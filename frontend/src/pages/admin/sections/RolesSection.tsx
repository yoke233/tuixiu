import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRole, deleteRole, listRoles, updateRole } from "../../../api/roles";
import type { RoleTemplate } from "../../../types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

export function RolesSection(props: Props) {
  const { active, effectiveProjectId, requireAdmin, setError } = props;

  const roleCreateKeyRef = useRef<HTMLInputElement>(null);
  const [roleSearch, setRoleSearch] = useState("");
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

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((role) => {
      const hay = [role.key, role.displayName ?? "", role.description ?? "", ...(role.envKeys ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [roleSearch, roles]);

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

  const onStartCreate = useCallback(() => {
    resetRoleEdit();
    setRoleKey("");
    setRoleDisplayName("");
    setRolePromptTemplate("");
    setRoleInitScript("");
    setRoleInitTimeoutSeconds("300");
    setRoleEnvText("");
    queueMicrotask(() => roleCreateKeyRef.current?.focus());
  }, [resetRoleEdit]);

  return (
    <section className="card" hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>角色模板</h2>
          <div className="muted">维护 Prompt / initScript / envText / 超时等配置。</div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" size="sm" onClick={onStartCreate} disabled={!effectiveProjectId || rolesLoading}>
            新建
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshRoles()} disabled={!effectiveProjectId || rolesLoading}>
            刷新
          </Button>
        </div>
      </div>

      {!effectiveProjectId ? (
        <div className="muted" style={{ marginTop: 10 }}>
          请先创建/选择 Project
        </div>
      ) : rolesLoading ? (
        <div className="muted" style={{ marginTop: 10 }}>
          加载中…
        </div>
      ) : rolesError ? (
        <div className="muted" style={{ marginTop: 10 }} title={rolesError}>
          角色列表加载失败：{rolesError}
        </div>
      ) : (
        <div className="adminSplit" style={{ marginTop: 12 }}>
          <div className="rounded-lg border bg-card p-4">
            <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 800 }}>角色列表</div>
              <div className="muted">{filteredRoles.length ? `显示 ${filteredRoles.length} / ${roles.length}` : "—"}</div>
            </div>

            <label className="label" style={{ marginTop: 10 }}>
              搜索
              <Input value={roleSearch} onChange={(e) => setRoleSearch(e.target.value)} placeholder="按 key / 名称 / env keys 过滤…" />
            </label>

            <div className="tableScroll" style={{ marginTop: 12, maxHeight: 520 }}>
              {filteredRoles.length ? (
                <ul className="list" style={{ marginTop: 0 }}>
                  {filteredRoles.map((role) => {
                    const selected = roleEditingId === role.id;
                    const busy = roleSavingId === role.id || roleDeletingId === role.id;
                    return (
                      <li key={role.id} className={`listItem adminListItem ${selected ? "selected" : ""}`}>
                        <button
                          type="button"
                          className="adminListItemButton"
                          onClick={() => startRoleEdit(role)}
                          disabled={busy}
                        >
                          <div className="row spaceBetween" style={{ gap: 10, alignItems: "center" }}>
                            <div className="cellStack" style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 800 }}>{role.displayName ?? role.key}</div>
                              <div className="cellSub">
                                <code>{role.key}</code> · {role.initTimeoutSeconds}s · {new Date(role.updatedAt).toLocaleString()}
                              </div>
                              {role.description ? <div className="cellSub">{role.description}</div> : null}
                              {role.envKeys?.length ? <div className="cellSub">env: {role.envKeys.join(", ")}</div> : null}
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                copyRoleToCreate(role);
                              }}
                              disabled={busy}
                              title="复制到新建（不填 key）"
                            >
                              复制
                            </Button>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="muted">暂无 RoleTemplate</div>
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            {editingRole ? (
              <form onSubmit={(e) => void onUpdateRole(e)} className="form">
                <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
                  <div>
                    <h3 style={{ marginTop: 0, marginBottom: 4 }}>编辑角色</h3>
                    <div className="muted">
                      key: <code>{editingRole.key}</code> · id: <code>{editingRole.id}</code>
                    </div>
                  </div>
                  <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <Button type="button" variant="secondary" size="sm" onClick={() => copyRoleToCreate(editingRole)} disabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}>
                      复制到新建
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => void onDeleteRole(editingRole)} disabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}>
                      {roleDeletingId === editingRole.id ? "删除中…" : "删除"}
                    </Button>
                  </div>
                </div>

                <label className="label">
                  显示名称 *
                  <Input value={roleEditDisplayName} onChange={(e) => setRoleEditDisplayName(e.target.value)} />
                </label>
                <label className="label">
                  描述（可选）
                  <Input value={roleEditDescription} onChange={(e) => setRoleEditDescription(e.target.value)} />
                </label>
                <label className="label">
                  Prompt Template（可选）
                  <Textarea value={roleEditPromptTemplate} onChange={(e) => setRoleEditPromptTemplate(e.target.value)} />
                </label>
                <label className="label">
                  initScript（bash，可选）
                  <Textarea value={roleEditInitScript} onChange={(e) => setRoleEditInitScript(e.target.value)} />
                </label>
                <label className="label">
                  init 超时秒数（可选）
                  <Input value={roleEditInitTimeoutSeconds} onChange={(e) => setRoleEditInitTimeoutSeconds(e.target.value)} placeholder="300" />
                </label>
                <label className="label">
                  envText（仅 admin，可选）
                  <div className="row gap" style={{ alignItems: "center" }}>
                    <Checkbox checked={roleEditEnvTextEnabled} onCheckedChange={(v) => setRoleEditEnvTextEnabled(v === true)} />
                    <div className="muted">
                      勾选后允许编辑并保存（留空=清空）。
                      {editingRole.envKeys?.length ? ` 当前 keys: ${editingRole.envKeys.join(", ")}` : ""}
                    </div>
                  </div>
                  <Textarea value={roleEditEnvText} onChange={(e) => setRoleEditEnvText(e.target.value)} rows={4} readOnly={!roleEditEnvTextEnabled} placeholder={"FOO=bar\nexport TOKEN=xxx"} />
                </label>

                <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <Button type="submit" disabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}>
                    {roleSavingId === editingRole.id ? "保存中…" : "保存修改"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={resetRoleEdit}>
                    取消
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={(e) => void onCreateRole(e)} className="form">
                <h3 style={{ marginTop: 0, marginBottom: 4 }}>创建 RoleTemplate</h3>
                <div className="muted">建议先从现有角色“复制到新建”，再改 key。</div>

                <label className="label">
                  Role Key *
                  <Input ref={roleCreateKeyRef} value={roleKey} onChange={(e) => setRoleKey(e.target.value)} placeholder="backend-dev" />
                </label>
                <label className="label">
                  显示名称 *
                  <Input value={roleDisplayName} onChange={(e) => setRoleDisplayName(e.target.value)} placeholder="后端开发" />
                </label>
                <label className="label">
                  Prompt Template（可选）
                  <Textarea value={rolePromptTemplate} onChange={(e) => setRolePromptTemplate(e.target.value)} placeholder="你是 {{role.name}}，请优先写单测。" />
                </label>
                <label className="label">
                  initScript（bash，可选）
                  <Textarea value={roleInitScript} onChange={(e) => setRoleInitScript(e.target.value)} placeholder={"# 可使用环境变量：GH_TOKEN/TUIXIU_WORKSPACE 等\n\necho init"} />
                </label>
                <label className="label">
                  init 超时秒数（可选）
                  <Input value={roleInitTimeoutSeconds} onChange={(e) => setRoleInitTimeoutSeconds(e.target.value)} placeholder="300" />
                </label>
                <label className="label">
                  envText（.env，可选）
                  <Textarea value={roleEnvText} onChange={(e) => setRoleEnvText(e.target.value)} rows={4} placeholder={"FOO=bar\nexport TOKEN=xxx"} />
                </label>
                <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <Button type="submit" disabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}>
                    创建
                  </Button>
                  <Button type="button" variant="secondary" onClick={onStartCreate}>
                    清空
                  </Button>
                </div>

                <div className="muted" style={{ marginTop: 10 }}>
                  initScript 默认在 workspace 执行；建议把持久内容写到 <code>$HOME/.tuixiu/projects/&lt;projectId&gt;</code>。
                  <br />
                  envText 仅在携带 admin 凭证时返回；请避免在其中存放不必要的敏感信息。
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
