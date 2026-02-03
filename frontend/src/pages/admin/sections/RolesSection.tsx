import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { createRole, deleteRole, listRoles, updateRole } from "../../../api/roles";
import { getRoleSkills, putRoleSkills, type RoleSkillItem } from "../../../api/roleSkills";
import {
  listSkillVersions,
  searchSkills,
  type SkillSearchItem,
  type SkillVersion,
} from "../../../api/skills";
import type {
  AgentInputItem,
  AgentInputsApply,
  AgentInputsManifestV1,
  AgentInputsTargetRoot,
  RoleTemplate,
} from "../../../types";
import { Badge } from "@/components/ui/badge";
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
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

type RoleTemplateManageMode = "create" | "edit";

function RoleTemplateManageForm(props: {
  mode: RoleTemplateManageMode;
  roleKey: string;
  roleKeyInputRef?: React.RefObject<HTMLInputElement | null>;
  onRoleKeyChange?: (next: string) => void;
  roleKeyReadOnly?: boolean;
  displayName: string;
  onDisplayNameChange: (next: string) => void;
  description: string;
  onDescriptionChange: (next: string) => void;
  promptTemplate: string;
  onPromptTemplateChange: (next: string) => void;
  agentsMdText?: string;
  onAgentsMdTextChange?: (next: string) => void;
  initScript: string;
  onInitScriptChange: (next: string) => void;
  initTimeoutSeconds: string;
  onInitTimeoutSecondsChange: (next: string) => void;
  envText: string;
  onEnvTextChange: (next: string) => void;
  envTextEnabled?: boolean;
  onEnvTextEnabledChange?: (next: boolean) => void;
  envKeysHint?: string[] | null;
  submitLabel: string;
  submitBusy?: boolean;
  submitDisabled?: boolean;
  onCancel: () => void;
  onClear?: () => void;
  children?: ReactNode;
}) {
  const {
    mode,
    roleKey,
    roleKeyInputRef,
    onRoleKeyChange,
    roleKeyReadOnly,
    displayName,
    onDisplayNameChange,
    description,
    onDescriptionChange,
    promptTemplate,
    onPromptTemplateChange,
    agentsMdText,
    onAgentsMdTextChange,
    initScript,
    onInitScriptChange,
    initTimeoutSeconds,
    onInitTimeoutSecondsChange,
    envText,
    onEnvTextChange,
    envTextEnabled,
    onEnvTextEnabledChange,
    envKeysHint,
    submitLabel,
    submitBusy,
    submitDisabled,
    onCancel,
    onClear,
    children,
  } = props;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="rounded-lg border bg-card p-4">
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800 }}>基础配置</div>
          <div className="muted" style={{ fontSize: 12 }}>
            必填：Role Key / 显示名称
          </div>
        </div>
        <div className="stack" style={{ gap: 12, marginTop: 12 }}>
          <label className="label">
            Role Key *
            <Input
              ref={roleKeyInputRef}
              value={roleKey}
              onChange={(e) => onRoleKeyChange?.(e.target.value)}
              readOnly={roleKeyReadOnly}
              placeholder="backend-dev"
            />
          </label>

          <div className="row gap" style={{ flexWrap: "wrap" }}>
            <label className="label" style={{ flex: 1, minWidth: 260 }}>
              显示名称 *
              <Input
                value={displayName}
                onChange={(e) => onDisplayNameChange(e.target.value)}
                placeholder={mode === "create" ? "后端开发" : undefined}
              />
            </label>
            <label className="label" style={{ flex: 2, minWidth: 320 }}>
              描述（可选）
              <Input
                value={description}
                onChange={(e) => onDescriptionChange(e.target.value)}
                placeholder={mode === "create" ? "用于选择/提示的简短说明" : undefined}
              />
            </label>
          </div>

          <label className="label">
            角色指令（AGENTS.md / Prompt Template，可选）
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              推荐只维护这一份内容；保存时会写入 Prompt Template，并可同步到 Agent 文件里的{" "}
              <code>.codex/AGENTS.md</code>（若启用 Agent 文件）。
            </div>
            <Textarea
              value={agentsMdText ?? promptTemplate}
              onChange={(e) => {
                const v = e.target.value;
                onPromptTemplateChange(v);
                onAgentsMdTextChange?.(v);
              }}
              placeholder={mode === "create" ? "你是 {{role.name}}，请优先写单测。" : undefined}
            />
          </label>

          <label className="label">
            initScript（bash，可选）
            <Textarea
              value={initScript}
              onChange={(e) => onInitScriptChange(e.target.value)}
              placeholder={mode === "create" ? "# 可使用环境变量：GH_TOKEN/TUIXIU_WORKSPACE 等\n\necho init" : undefined}
            />
          </label>

          <label className="label">
            init 超时秒数（可选）
            <Input
              value={initTimeoutSeconds}
              onChange={(e) => onInitTimeoutSecondsChange(e.target.value)}
              placeholder="300"
            />
          </label>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800 }}>
            envText（仅 admin）
            {envKeysHint?.length ? (
              <span className="muted" style={{ marginLeft: 8, fontWeight: 500 }}>
                keys: {envKeysHint.join(", ")}
              </span>
            ) : null}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            可选：用于注入环境变量
          </div>
        </div>
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          {mode === "edit" ? (
            <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <Checkbox
                checked={envTextEnabled === true}
                onCheckedChange={(v) => onEnvTextEnabledChange?.(v === true)}
              />
              <div className="muted">勾选后允许编辑并保存（留空=清空）。</div>
            </div>
          ) : null}
          <Textarea
            value={envText}
            onChange={(e) => onEnvTextChange(e.target.value)}
            rows={4}
            readOnly={mode === "edit" ? envTextEnabled !== true : false}
            placeholder={"FOO=bar\nexport TOKEN=xxx"}
          />
        </div>
      </div>

      {children}

      <div className="row gap" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
        <Button type="submit" disabled={submitDisabled === true}>
          {submitBusy ? "保存中…" : submitLabel}
        </Button>
        {onClear ? (
          <Button type="button" variant="secondary" onClick={onClear}>
            清空
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </div>
  );
}

function RoleSkillsCard(props: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  loadError?: string | null;
  saving?: boolean;
  onSave?: () => void;
  skills: RoleSkillItem[];
  setSkills: (updater: (prev: RoleSkillItem[]) => RoleSkillItem[]) => void;
  searchQ: string;
  onSearchQChange: (next: string) => void;
  searchLoading: boolean;
  searchError: string | null;
  searchResults: SkillSearchItem[];
  onSearch: () => void;
  onAddSkill: (it: SkillSearchItem) => void;
  onRemoveSkill: (skillId: string) => void;
  versionsById: Record<string, SkillVersion[]>;
  versionsLoadingById: Record<string, boolean>;
  ensureVersions: (skillId: string) => void;
}) {
  const {
    title,
    subtitle,
    loading,
    loadError,
    saving,
    onSave,
    skills,
    setSkills,
    searchQ,
    onSearchQChange,
    searchLoading,
    searchError,
    searchResults,
    onSearch,
    onAddSkill,
    onRemoveSkill,
    versionsById,
    versionsLoadingById,
    ensureVersions,
  } = props;

  const hasItems = skills.length > 0;
  const [open, setOpen] = useState(hasItems);
  const [userToggled, setUserToggled] = useState(false);
  const effectiveOpen = userToggled ? open : hasItems;

  return (
    <div className="rounded-lg border bg-card p-4">
      <button
        type="button"
        className="row spaceBetween"
        style={{
          width: "100%",
          alignItems: "baseline",
          flexWrap: "wrap",
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
        aria-expanded={effectiveOpen}
        onClick={() => {
          const currentOpen = userToggled ? open : hasItems;
          setUserToggled(true);
          setOpen(!currentOpen);
        }}
      >
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          {subtitle ? <div className="muted">{subtitle}</div> : null}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {hasItems ? `${skills.length} 项` : "未配置"} · {effectiveOpen ? "点击收起" : "点击展开"}
        </div>
      </button>

      {!effectiveOpen ? (
        <div className="muted" style={{ marginTop: 12 }}>
          {hasItems ? `已配置 ${skills.length} 项` : "未配置"}
        </div>
      ) : loading ? (
        <div className="muted" style={{ marginTop: 12 }}>
          加载中…
        </div>
      ) : loadError ? (
        <div className="muted" style={{ marginTop: 12 }} title={loadError}>
          加载失败：{loadError}
        </div>
      ) : (
        <>
          <div
            className="row gap"
            style={{ justifyContent: "flex-end", flexWrap: "wrap", marginTop: 12 }}
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onSearch}
              disabled={searchLoading}
            >
              {searchLoading ? "搜索中…" : "搜索"}
            </Button>
            {onSave ? (
              <Button
                type="button"
                size="sm"
                onClick={onSave}
                disabled={Boolean(saving) || Boolean(loading)}
              >
                {saving ? "保存中…" : "保存 Skills"}
              </Button>
            ) : null}
          </div>

          {skills.length ? (
            <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
              {skills.map((s) => (
                <div
                  key={s.skillId}
                  className="row"
                  style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
                >
                  <Badge variant="outline">{s.name || s.skillId}</Badge>

                  <Select
                    value={s.versionPolicy}
                    onValueChange={(v) => {
                      const nextPolicy = v === "pinned" ? "pinned" : "latest";
                      setSkills((prev) =>
                        prev.map((x) =>
                          x.skillId === s.skillId
                            ? {
                                ...x,
                                versionPolicy: nextPolicy,
                                pinnedVersionId: nextPolicy === "pinned" ? x.pinnedVersionId : null,
                              }
                            : x,
                        ),
                      );
                      if (nextPolicy === "pinned") ensureVersions(s.skillId);
                    }}
                  >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue placeholder="版本策略" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="latest">latest</SelectItem>
                      <SelectItem value="pinned">pinned</SelectItem>
                    </SelectContent>
                  </Select>

                  {s.versionPolicy === "pinned" ? (
                    <Select
                      value={s.pinnedVersionId ?? ""}
                      onValueChange={(v) =>
                        setSkills((prev) =>
                          prev.map((x) => (x.skillId === s.skillId ? { ...x, pinnedVersionId: v } : x)),
                        )
                      }
                    >
                      <SelectTrigger
                        className="w-[260px]"
                        disabled={versionsLoadingById[s.skillId] === true}
                      >
                        <SelectValue
                          placeholder={
                            versionsLoadingById[s.skillId] === true ? "加载版本中…" : "选择版本"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {(versionsById[s.skillId] ?? []).map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {new Date(v.importedAt).toLocaleString()} · {v.contentHash.slice(0, 8)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}

                  <label className="row" style={{ gap: 8, alignItems: "center" }}>
                    <Checkbox
                      checked={s.enabled}
                      onCheckedChange={(v) =>
                        setSkills((prev) =>
                          prev.map((x) => (x.skillId === s.skillId ? { ...x, enabled: v === true } : x)),
                        )
                      }
                    />
                    <span className="muted">启用</span>
                  </label>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRemoveSkill(s.skillId)}
                    disabled={saving === true}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 12 }}>
              当前未启用任何 skills。
            </div>
          )}

          <div className="row gap" style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Input
              value={searchQ}
              onChange={(e) => onSearchQChange(e.target.value)}
              placeholder="搜索 registry skills…"
            />
            <Button type="button" variant="secondary" onClick={onSearch} disabled={searchLoading}>
              {searchLoading ? "搜索中…" : "搜索 registry"}
            </Button>
          </div>

          {searchError ? (
            <div className="muted" style={{ marginTop: 10 }} title={searchError}>
              skills 搜索失败：{searchError}
            </div>
          ) : null}

          {searchResults.length ? (
            <ul className="list" style={{ marginTop: 12 }}>
              {searchResults.map((it) => {
                const already = skills.some((x) => x.skillId === it.skillId);
                return (
                  <li key={it.skillId} className="listItem">
                    <div className="row spaceBetween" style={{ gap: 10, alignItems: "center" }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 800 }}>{it.name}</div>
                        <div className="muted">
                          <code>{it.skillId}</code>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => onAddSkill(it)}
                        disabled={already || saving === true}
                      >
                        {already ? "已添加" : "添加"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="muted" style={{ marginTop: 10 }}>
              暂无可用技能/无匹配结果（若首次使用，请先导入 skills）。
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RoleAgentFilesCard(props: {
  title: string;
  subtitle?: string;
  statusHint?: string;
  manifest: AgentInputsManifestV1;
  setManifest: (updater: (prev: AgentInputsManifestV1) => AgentInputsManifestV1) => void;
  selectedId: string;
  onSelectedIdChange: (next: string) => void;
  onSave?: () => void;
  saving?: boolean;
  error?: string | null;
  errorDetails?: unknown | null;
  setError: (msg: string | null) => void;
  agentInputsInlineFileRef: React.RefObject<HTMLInputElement | null>;
  makeAgentInputId: () => string;
  normalizeItemForApply: (apply: AgentInputsApply, item: AgentInputItem) => AgentInputItem;
}) {
  const {
    title,
    subtitle,
    statusHint,
    manifest,
    setManifest,
    selectedId,
    onSelectedIdChange,
    onSave,
    saving,
    error,
    errorDetails,
    setError,
    agentInputsInlineFileRef,
    makeAgentInputId,
    normalizeItemForApply,
  } = props;

  const hasItems = manifest.items.length > 0;
  const [open, setOpen] = useState(hasItems);
  const [userToggled, setUserToggled] = useState(false);
  const effectiveOpen = userToggled ? open : hasItems;

  const selectedIndex = useMemo(() => {
    if (!selectedId) return -1;
    return manifest.items.findIndex((x) => x.id === selectedId);
  }, [manifest.items, selectedId]);

  const selectedItem = useMemo(() => {
    return selectedIndex >= 0 ? (manifest.items[selectedIndex] ?? null) : null;
  }, [manifest.items, selectedIndex]);

  const updateSelected = useCallback(
    (updater: (prev: AgentInputItem) => AgentInputItem) => {
      if (selectedIndex < 0) return;
      setManifest((prev) => {
        const nextItems = [...prev.items];
        const current = nextItems[selectedIndex];
        if (!current) return prev;
        nextItems[selectedIndex] = updater(current);
        return { ...prev, items: nextItems };
      });
    },
    [selectedIndex, setManifest],
  );

  const onAdd = useCallback(() => {
    const id = `agents-md-${makeAgentInputId()}`;
    const nextItem: AgentInputItem = {
      id,
      name: "AGENTS.md",
      apply: "writeFile",
      access: "rw",
      source: { type: "inlineText", text: "" },
      target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
    };
    setManifest((prev) => ({ ...prev, version: 1, items: [...prev.items, nextItem] }));
    onSelectedIdChange(id);
  }, [makeAgentInputId, onSelectedIdChange, setManifest]);

  const onCopy = useCallback(() => {
    if (!selectedItem) return;
    const id = `copy-${makeAgentInputId()}`;
    const copied: AgentInputItem = {
      ...selectedItem,
      id,
      source: { ...(selectedItem.source as any) },
      target: { ...(selectedItem.target as any) },
    };
    setManifest((prev) => ({ ...prev, version: 1, items: [...prev.items, copied] }));
    onSelectedIdChange(id);
  }, [makeAgentInputId, onSelectedIdChange, selectedItem, setManifest]);

  const onDelete = useCallback(() => {
    if (!selectedItem) return;
    setManifest((prev) => ({
      ...prev,
      version: 1,
      items: prev.items.filter((x) => x.id !== selectedItem.id),
    }));
    onSelectedIdChange("");
  }, [onSelectedIdChange, selectedItem, setManifest]);

  const onMove = useCallback(
    (dir: -1 | 1) => {
      if (selectedIndex < 0) return;
      setManifest((prev) => {
        const items = [...prev.items];
        const from = selectedIndex;
        const to = from + dir;
        if (to < 0 || to >= items.length) return prev;
        const [it] = items.splice(from, 1);
        if (!it) return prev;
        items.splice(to, 0, it);
        return { ...prev, items };
      });
    },
    [selectedIndex, setManifest],
  );

  return (
    <div className="rounded-lg border bg-card p-4">
      <button
        type="button"
        className="row spaceBetween"
        style={{
          width: "100%",
          alignItems: "baseline",
          flexWrap: "wrap",
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
        }}
        aria-expanded={effectiveOpen}
        onClick={() => {
          const currentOpen = userToggled ? open : hasItems;
          setUserToggled(true);
          setOpen(!currentOpen);
        }}
      >
        <div>
          <div style={{ fontWeight: 800 }}>{title}</div>
          {subtitle ? <div className="muted">{subtitle}</div> : null}
          {statusHint ? <div className="muted">{statusHint}</div> : null}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {hasItems ? `${manifest.items.length} 项` : "未配置"} · {effectiveOpen ? "点击收起" : "点击展开"}
        </div>
      </button>

      {!effectiveOpen ? (
        <div className="muted" style={{ marginTop: 12 }}>
          {hasItems ? `已配置 ${manifest.items.length} 项` : "未配置"}
        </div>
      ) : (
        <>
          <div
            className="row gap"
            style={{ justifyContent: "flex-end", flexWrap: "wrap", marginTop: 12 }}
          >
            <Button type="button" variant="secondary" size="sm" onClick={onAdd}>
              新增
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCopy}
              disabled={!selectedItem}
            >
              复制
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onDelete}
              disabled={!selectedItem}
            >
              删除
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onMove(-1)}
              disabled={selectedIndex <= 0}
            >
              上移
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onMove(1)}
              disabled={selectedIndex < 0 || selectedIndex >= manifest.items.length - 1}
            >
              下移
            </Button>
            {onSave ? (
              <Button type="button" size="sm" onClick={onSave} disabled={saving === true}>
                {saving ? "保存中…" : "保存 Agent 文件"}
              </Button>
            ) : null}
          </div>

          {error ? (
            <div className="muted" style={{ marginTop: 10 }} title={error}>
              Agent 文件保存失败：{error}
            </div>
          ) : null}
          {errorDetails ? (
            <pre className="pre" style={{ marginTop: 10 }}>
              {JSON.stringify(errorDetails, null, 2)}
            </pre>
          ) : null}

          <div
            className="row"
            style={{ marginTop: 12, gap: 12, alignItems: "stretch", flexWrap: "wrap" }}
          >
            <div className="rounded-lg border bg-card p-4" style={{ flex: 1, minWidth: 380 }}>
              <div className="row spaceBetween" style={{ gap: 10, alignItems: "baseline" }}>
                <div style={{ fontWeight: 800 }}>items</div>
                <div className="muted">
                  {manifest.items.length ? `共 ${manifest.items.length} 项` : "—"}
                </div>
              </div>

              <div
                className="row"
                style={{ marginTop: 10, gap: 10, fontSize: 12, fontWeight: 700 }}
              >
                <div style={{ flex: 1.3, minWidth: 0 }}>名称</div>
                <div style={{ width: 120 }}>apply</div>
                <div style={{ width: 110 }}>root</div>
                <div style={{ flex: 2, minWidth: 0 }}>target.path</div>
                <div style={{ width: 120 }}>source</div>
              </div>

              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {manifest.items.length ? (
                  manifest.items.map((it) => {
                    const selected = it.id === selectedId;
                    const srcType = (it.source as any)?.type ?? "—";
                    const name =
                      typeof (it as any)?.name === "string" ? String((it as any).name).trim() : "";
                    return (
                      <div
                        key={it.id}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelectedIdChange(it.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSelectedIdChange(it.id);
                          }
                        }}
                        style={{
                          border: "1px solid var(--card-border)",
                          borderColor: selected ? "var(--primary)" : "var(--card-border)",
                          borderRadius: 12,
                          padding: 10,
                          cursor: "pointer",
                          background: "var(--list-bg)",
                        }}
                      >
                        <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
                          <div
                            style={{
                              flex: 1.3,
                              minWidth: 0,
                              fontSize: 12,
                              fontWeight: 800,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={name || ""}
                          >
                            {name || "—"}
                          </div>
                          <div style={{ width: 120, fontSize: 12 }}>{it.apply}</div>
                          <div style={{ width: 110, fontSize: 12 }}>{it.target?.root ?? "—"}</div>
                          <div
                            style={{
                              flex: 2,
                              minWidth: 0,
                              fontSize: 12,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                            title={it.target?.path ?? ""}
                          >
                            {it.target?.path ?? ""}
                          </div>
                          <div style={{ width: 120, fontSize: 12 }}>{srcType}</div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="muted">暂无 items，点击“新增”创建。</div>
                )}
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4" style={{ flex: 1, minWidth: 380 }}>
              <div className="row spaceBetween" style={{ gap: 10, alignItems: "baseline" }}>
                <div style={{ fontWeight: 800 }}>详情</div>
                <div className="muted">{selectedItem ? `编辑：${selectedItem.id}` : "—"}</div>
              </div>

              {selectedItem ? (
                <div className="stack" style={{ gap: 12, marginTop: 10 }}>
                  <label className="label">
                    名称（可选）
                    <Input
                      value={(selectedItem as any).name ?? ""}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        updateSelected((prev) => ({
                          ...prev,
                          ...(v ? { name: v } : { name: undefined }),
                        }));
                      }}
                      placeholder="例如：AGENTS.md / config.toml"
                    />
                  </label>

                  <label className="label">
                    apply *
                    <Select
                      value={selectedItem.apply}
                      onValueChange={(v) =>
                        updateSelected((prev) => normalizeItemForApply(v as AgentInputsApply, prev))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择 apply" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="writeFile">writeFile</SelectItem>
                        <SelectItem value="downloadExtract">downloadExtract</SelectItem>
                        <SelectItem value="copy">copy</SelectItem>
                        <SelectItem value="bindMount">bindMount</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>

                  <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                    <label className="label" style={{ flex: 1, minWidth: 200 }}>
                      target.root *
                      <Select
                        value={(selectedItem.target?.root ?? "WORKSPACE") as AgentInputsTargetRoot}
                        onValueChange={(v) =>
                          updateSelected((prev) => ({
                            ...prev,
                            target: { ...(prev.target as any), root: v as AgentInputsTargetRoot },
                          }))
                        }
                      >
                        <SelectTrigger disabled={selectedItem.apply === "bindMount"}>
                          <SelectValue placeholder="选择 root" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="WORKSPACE">WORKSPACE</SelectItem>
                          <SelectItem value="USER_HOME">USER_HOME</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>

                    <label className="label" style={{ flex: 2, minWidth: 260 }}>
                      target.path *
                      <Input
                        value={selectedItem.target?.path ?? ""}
                        onChange={(e) =>
                          updateSelected((prev) => ({
                            ...prev,
                            target: { ...(prev.target as any), path: e.target.value },
                          }))
                        }
                        disabled={selectedItem.apply === "bindMount"}
                        placeholder={selectedItem.apply === "bindMount" ? "." : ".codex/AGENTS.md"}
                      />
                    </label>
                  </div>

                  {selectedItem.source.type === "hostPath" ? (
                    <label className="label">
                      source.hostPath
                      <Input
                        value={selectedItem.source.path ?? ""}
                        onChange={(e) =>
                          updateSelected((prev) => ({
                            ...prev,
                            source: { ...(prev.source as any), type: "hostPath", path: e.target.value },
                          }))
                        }
                        placeholder="C:\\path\\to\\file-or-dir"
                      />
                    </label>
                  ) : null}

                  {selectedItem.source.type === "httpZip" ? (
                    <div className="stack" style={{ gap: 12 }}>
                      <label className="label">
                        source.httpZip.uri
                        <Input
                          value={selectedItem.source.uri ?? ""}
                          onChange={(e) =>
                            updateSelected((prev) => ({
                              ...prev,
                              source: { ...(prev.source as any), type: "httpZip", uri: e.target.value },
                            }))
                          }
                          placeholder="/api/acp-proxy/skills/<...>.zip"
                        />
                      </label>
                      <label className="label">
                        source.httpZip.contentHash（可选）
                        <Input
                          value={(selectedItem.source as any).contentHash ?? ""}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            updateSelected((prev) => ({
                              ...prev,
                              source: {
                                ...(prev.source as any),
                                type: "httpZip",
                                ...(v ? { contentHash: v } : { contentHash: undefined }),
                              },
                            }));
                          }}
                          placeholder="sha256:..."
                        />
                      </label>
                    </div>
                  ) : null}

                  {selectedItem.source.type === "inlineText" ? (
                    <label className="label">
                      source.inlineText.text
                      <div
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer?.files?.[0];
                          if (!f) return;
                          if (typeof f.text !== "function") return;
                          if (f.size > 512 * 1024) {
                            setError("文件过大：最多支持 512KB 文本文件");
                            return;
                          }
                          void f.text().then((text) => {
                            updateSelected((prev) => ({
                              ...prev,
                              source: { ...(prev.source as any), type: "inlineText", text },
                            }));
                          });
                        }}
                        style={{
                          border: "1px dashed var(--card-border)",
                          borderRadius: 12,
                          padding: 10,
                          background: "color-mix(in oklab, var(--card), transparent 0%)",
                        }}
                      >
                        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                          可直接把文本文件（.md/.txt/.toml 等）拖到这里，会自动读取并填入。
                        </div>
                        <Textarea
                          aria-label="source.inlineText.text"
                          value={selectedItem.source.text ?? ""}
                          onChange={(e) =>
                            updateSelected((prev) => ({
                              ...prev,
                              source: { ...(prev.source as any), type: "inlineText", text: e.target.value },
                            }))
                          }
                          rows={12}
                          placeholder={
                            "# e.g. .codex/AGENTS.md\n你在 Windows PowerShell（pwsh）环境中工作，回答我的时候一律中文。\n"
                          }
                        />
                        <input
                          type="file"
                          accept="text/*,.md,.txt,.toml,.json,.yaml,.yml,.env"
                          style={{ display: "none" }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            if (typeof f.text !== "function") return;
                            if (f.size > 512 * 1024) {
                              setError("文件过大：最多支持 512KB 文本文件");
                              return;
                            }
                            void f.text().then((text) => {
                              updateSelected((prev) => ({
                                ...prev,
                                source: { ...(prev.source as any), type: "inlineText", text },
                              }));
                            });
                          }}
                          ref={agentInputsInlineFileRef}
                        />
                        <div className="row gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => agentInputsInlineFileRef.current?.click()}
                          >
                            选择文件
                          </Button>
                          <div className="muted" style={{ fontSize: 12 }}>
                            注意：不会上传文件，只是在浏览器读取内容后填入文本框。
                          </div>
                        </div>
                      </div>
                    </label>
                  ) : null}

                  <div className="muted" style={{ fontSize: 12 }}>
                    顺序即执行顺序；<code>name</code> 只是展示用；<code>target.path</code> 必须是相对路径且不得包含{" "}
                    <code>..</code>。
                  </div>
                </div>
              ) : (
                <div className="muted" style={{ marginTop: 10 }}>
                  选择左侧某个 item 以编辑。
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function getAgentsMdInlineText(manifest: AgentInputsManifestV1): { id: string; text: string } | null {
  for (const it of manifest.items) {
    if (!it?.target || it.target.path !== ".codex/AGENTS.md") continue;
    const src = it.source as any;
    if (!src || src.type !== "inlineText") continue;
    return { id: String(it.id ?? ""), text: String(src.text ?? "") };
  }
  return null;
}

function upsertAgentsMdInlineText(args: {
  manifest: AgentInputsManifestV1;
  text: string;
  makeAgentInputId: () => string;
}): { manifest: AgentInputsManifestV1; id: string } {
  const { manifest, text, makeAgentInputId } = args;
  const idx = manifest.items.findIndex((it) => it?.target?.path === ".codex/AGENTS.md");
  if (idx >= 0) {
    const existing = manifest.items[idx];
    if (!existing) return { manifest, id: "" };
    const nextItem: AgentInputItem = {
      ...existing,
      name: "AGENTS.md",
      apply: "writeFile",
      access: (existing as any).access ?? "rw",
      source: { type: "inlineText", text },
      target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
    };
    const nextItems = [...manifest.items];
    nextItems[idx] = nextItem;
    return { manifest: { ...manifest, version: 1, items: nextItems }, id: nextItem.id };
  }

  const id = `agents-md-${makeAgentInputId()}`;
  const nextItem: AgentInputItem = {
    id,
    name: "AGENTS.md",
    apply: "writeFile",
    access: "rw",
    source: { type: "inlineText", text },
    target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
  };
  return { manifest: { ...manifest, version: 1, items: [...manifest.items, nextItem] }, id };
}

export function RolesSection(props: Props) {
  const { active, effectiveProjectId, requireAdmin, setError } = props;

  const roleCreateKeyRef = useRef<HTMLInputElement>(null);
  const agentInputsInlineFileRef = useRef<HTMLInputElement>(null);
  const [roleSearch, setRoleSearch] = useState("");
  const [roleKey, setRoleKey] = useState("");
  const [roleDisplayName, setRoleDisplayName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [rolePromptTemplate, setRolePromptTemplate] = useState("");
  const [roleInitScript, setRoleInitScript] = useState("");
  const [roleInitTimeoutSeconds, setRoleInitTimeoutSeconds] = useState("300");
  const [roleEnvText, setRoleEnvText] = useState("");
  const [roleCreateAgentInputs, setRoleCreateAgentInputs] = useState<
    AgentInputsManifestV1 | null | undefined
  >(undefined);
  const [roleCreateSkillsDraft, setRoleCreateSkillsDraft] = useState<RoleSkillItem[] | null>(null);
  const [createSkillsSearchQ, setCreateSkillsSearchQ] = useState("");
  const [createSkillsSearchLoading, setCreateSkillsSearchLoading] = useState(false);
  const [createSkillsSearchError, setCreateSkillsSearchError] = useState<string | null>(null);
  const [createSkillsSearchResults, setCreateSkillsSearchResults] = useState<SkillSearchItem[]>([]);
  const [createSkillVersionsById, setCreateSkillVersionsById] = useState<
    Record<string, SkillVersion[]>
  >({});
  const [createSkillVersionsLoadingById, setCreateSkillVersionsLoadingById] = useState<
    Record<string, boolean>
  >({});

  const [createAgentInputsSelectedId, setCreateAgentInputsSelectedId] = useState("");

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

  const [roleAgentInputs, setRoleAgentInputs] = useState<AgentInputsManifestV1>({
    version: 1,
    items: [],
  });
  const [roleAgentInputsSelectedId, setRoleAgentInputsSelectedId] = useState("");
  const [roleAgentInputsSaving, setRoleAgentInputsSaving] = useState(false);
  const [roleAgentInputsError, setRoleAgentInputsError] = useState<string | null>(null);
  const [roleAgentInputsErrorDetails, setRoleAgentInputsErrorDetails] = useState<unknown | null>(
    null,
  );

  const [roleSkills, setRoleSkills] = useState<RoleSkillItem[]>([]);
  const [roleSkillsLoading, setRoleSkillsLoading] = useState(false);
  const [roleSkillsError, setRoleSkillsError] = useState<string | null>(null);
  const [roleSkillsSaving, setRoleSkillsSaving] = useState(false);

  const [roleSkillsSearchQ, setRoleSkillsSearchQ] = useState("");
  const [roleSkillsSearchLoading, setRoleSkillsSearchLoading] = useState(false);
  const [roleSkillsSearchError, setRoleSkillsSearchError] = useState<string | null>(null);
  const [roleSkillsSearchResults, setRoleSkillsSearchResults] = useState<SkillSearchItem[]>([]);

  const [roleSkillVersionsById, setRoleSkillVersionsById] = useState<
    Record<string, SkillVersion[]>
  >({});
  const [roleSkillVersionsLoadingById, setRoleSkillVersionsLoadingById] = useState<
    Record<string, boolean>
  >({});

  const editingRole = useMemo(
    () => roles.find((role) => role.id === roleEditingId) ?? null,
    [roleEditingId, roles],
  );

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((role) => {
      const hay = [
        role.key,
        role.displayName ?? "",
        role.description ?? "",
        ...(role.envKeys ?? []),
      ]
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

    setRoleAgentInputs({ version: 1, items: [] });
    setRoleAgentInputsSelectedId("");
    setRoleAgentInputsSaving(false);
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);

    setRoleSkills([]);
    setRoleSkillsLoading(false);
    setRoleSkillsError(null);
    setRoleSkillsSaving(false);
    setRoleSkillsSearchQ("");
    setRoleSkillsSearchLoading(false);
    setRoleSkillsSearchError(null);
    setRoleSkillsSearchResults([]);
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

  useEffect(() => {
    if (!active) return;
    if (!effectiveProjectId || !roleEditingId) return;

    setRoleSkillsError(null);
    setRoleSkillsLoading(true);
    void (async () => {
      try {
        if (!requireAdmin()) return;
        const res = await getRoleSkills(effectiveProjectId, roleEditingId);
        setRoleSkills(Array.isArray(res.items) ? res.items : []);
      } catch (e) {
        setRoleSkillsError(e instanceof Error ? e.message : String(e));
        setRoleSkills([]);
      } finally {
        setRoleSkillsLoading(false);
      }
    })();
  }, [active, effectiveProjectId, requireAdmin, roleEditingId]);

  const startRoleEdit = useCallback((role: RoleTemplate) => {
    setRoleEditingId(role.id);
    setRoleEditDisplayName(role.displayName ?? "");
    setRoleEditDescription(role.description ?? "");
    setRoleEditPromptTemplate(role.promptTemplate ?? "");
    setRoleEditInitScript(role.initScript ?? "");
    setRoleEditInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
    setRoleEditEnvTextEnabled(false);
    setRoleEditEnvText(role.envText ?? "");

    const raw = role.agentInputs as any;
    const itemsRaw =
      raw && typeof raw === "object" && raw.version === 1 && Array.isArray(raw.items)
        ? raw.items
        : [];
    const nextAgentInputs: AgentInputsManifestV1 = {
      version: 1,
      ...(raw && typeof raw === "object" && raw.envPatch ? { envPatch: raw.envPatch as any } : {}),
      items: itemsRaw.map((it: any) => ({
        id: String(it?.id ?? ""),
        ...(it?.name ? { name: String(it.name ?? "").trim() || undefined } : {}),
        apply: it?.apply as AgentInputsApply,
        ...(it?.access ? { access: it.access } : {}),
        source:
          it?.source && typeof it.source === "object"
            ? { ...(it.source as any) }
            : (it?.source as any),
        target:
          it?.target && typeof it.target === "object"
            ? { ...(it.target as any) }
            : (it?.target as any),
      })),
    };
    setRoleAgentInputs(nextAgentInputs);
    setRoleAgentInputsSelectedId(nextAgentInputs.items[0]?.id ?? "");
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);
  }, []);

  const copyRoleToCreate = useCallback(
    (
      role: RoleTemplate,
      opts?: { agentInputs?: AgentInputsManifestV1 | null; skills?: RoleSkillItem[] },
    ) => {
      setRoleKey("");
      setRoleDisplayName(role.displayName ?? "");
      setRoleDescription(role.description ?? "");
      setRolePromptTemplate(role.promptTemplate ?? "");
      setRoleInitScript(role.initScript ?? "");
      setRoleInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
      setRoleEnvText(role.envText ?? "");
      setRoleCreateAgentInputs(opts?.agentInputs ?? role.agentInputs ?? null);
      setRoleCreateSkillsDraft(opts?.skills ? opts.skills.map((s) => ({ ...s })) : null);
      setTimeout(() => roleCreateKeyRef.current?.focus(), 0);
    },
    [],
  );

  const copyEditingRoleToCreate = useCallback(() => {
    if (!editingRole) return;
    const copiedAgentInputs: AgentInputsManifestV1 = {
      version: 1,
      ...(roleAgentInputs.envPatch ? { envPatch: roleAgentInputs.envPatch } : {}),
      items: roleAgentInputs.items.map((it) => ({
        ...it,
        source: { ...(it.source as any) },
        target: { ...(it.target as any) },
      })),
    };
    const copiedSkills = roleSkills.map((s) => ({ ...s }));
    resetRoleEdit();
    copyRoleToCreate(editingRole, { agentInputs: copiedAgentInputs, skills: copiedSkills });
  }, [
    copyRoleToCreate,
    editingRole,
    resetRoleEdit,
    roleAgentInputs.envPatch,
    roleAgentInputs.items,
    roleSkills,
  ]);

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
        const created = await createRole(effectiveProjectId, {
          key,
          displayName: name,
          description: roleDescription.trim() || undefined,
          promptTemplate: rolePromptTemplate.trim() || undefined,
          initScript: roleInitScript.trim() || undefined,
          envText: roleEnvText.trim() || undefined,
          initTimeoutSeconds: Number(roleInitTimeoutSeconds) || undefined,
          ...(roleCreateAgentInputs !== undefined ? { agentInputs: roleCreateAgentInputs } : {}),
        });

        if (roleCreateSkillsDraft?.length) {
          await putRoleSkills(
            effectiveProjectId,
            created.id,
            roleCreateSkillsDraft.map((x) => ({
              skillId: x.skillId,
              versionPolicy: x.versionPolicy,
              ...(x.pinnedVersionId ? { pinnedVersionId: x.pinnedVersionId } : {}),
              enabled: x.enabled,
            })),
          ).catch(() => {});
        }
        setRoleKey("");
        setRoleDisplayName("");
        setRoleDescription("");
        setRolePromptTemplate("");
        setRoleInitScript("");
        setRoleInitTimeoutSeconds("300");
        setRoleEnvText("");
        setRoleCreateAgentInputs(undefined);
        setRoleCreateSkillsDraft(null);
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
      roleDescription,
      roleEnvText,
      roleInitScript,
      roleInitTimeoutSeconds,
      roleKey,
      roleCreateAgentInputs,
      roleCreateSkillsDraft,
      rolePromptTemplate,
      putRoleSkills,
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

  const onRoleSkillsSearch = useCallback(async () => {
    setRoleSkillsSearchError(null);
    setError(null);
    if (!requireAdmin()) return;
    const q = roleSkillsSearchQ.trim();

    setRoleSkillsSearchLoading(true);
    try {
      const res = await searchSkills({ provider: "registry", q: q || undefined, limit: 20 });
      setRoleSkillsSearchResults(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setRoleSkillsSearchError(e instanceof Error ? e.message : String(e));
      setRoleSkillsSearchResults([]);
    } finally {
      setRoleSkillsSearchLoading(false);
    }
  }, [requireAdmin, roleSkillsSearchQ, searchSkills, setError]);

  const onCreateRoleSkillsSearch = useCallback(async () => {
    setCreateSkillsSearchError(null);
    setError(null);
    if (!requireAdmin()) return;
    const q = createSkillsSearchQ.trim();

    setCreateSkillsSearchLoading(true);
    try {
      const res = await searchSkills({ provider: "registry", q: q || undefined, limit: 20 });
      setCreateSkillsSearchResults(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setCreateSkillsSearchError(e instanceof Error ? e.message : String(e));
      setCreateSkillsSearchResults([]);
    } finally {
      setCreateSkillsSearchLoading(false);
    }
  }, [createSkillsSearchQ, requireAdmin, searchSkills, setError]);

  const addRoleSkill = useCallback((it: SkillSearchItem) => {
    setRoleSkills((prev) => {
      if (prev.some((x) => x.skillId === it.skillId)) return prev;
      return [
        ...prev,
        {
          skillId: it.skillId,
          name: it.name,
          versionPolicy: it.latestVersion ? "latest" : "pinned",
          pinnedVersionId: null,
          enabled: true,
        },
      ];
    });
  }, []);

  const addCreateRoleSkill = useCallback((it: SkillSearchItem) => {
    setRoleCreateSkillsDraft((prev) => {
      const base = Array.isArray(prev) ? prev : [];
      if (base.some((x) => x.skillId === it.skillId)) return prev;
      return [
        ...base,
        {
          skillId: it.skillId,
          name: it.name,
          versionPolicy: it.latestVersion ? "latest" : "pinned",
          pinnedVersionId: null,
          enabled: true,
        },
      ];
    });
  }, []);

  const ensureRoleSkillVersions = useCallback(
    async (skillId: string) => {
      if (!requireAdmin()) return;
      if (roleSkillVersionsById[skillId]) return;

      setRoleSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: true }));
      try {
        const vs = await listSkillVersions(skillId);
        setRoleSkillVersionsById((prev) => ({ ...prev, [skillId]: vs }));
        setRoleSkills((prev) => {
          const idx = prev.findIndex((x) => x.skillId === skillId);
          if (idx < 0) return prev;
          const item = prev[idx];
          if (!item) return prev;
          if (item.versionPolicy !== "pinned") return prev;
          if (item.pinnedVersionId) return prev;
          const first = vs[0]?.id ?? null;
          if (!first) return prev;
          const next = [...prev];
          next[idx] = { ...item, pinnedVersionId: first };
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRoleSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [listSkillVersions, requireAdmin, roleSkillVersionsById, setError],
  );

  const ensureCreateRoleSkillVersions = useCallback(
    async (skillId: string) => {
      if (!requireAdmin()) return;
      if (createSkillVersionsById[skillId]) return;

      setCreateSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: true }));
      try {
        const vs = await listSkillVersions(skillId);
        setCreateSkillVersionsById((prev) => ({ ...prev, [skillId]: vs }));
        setRoleCreateSkillsDraft((prev) => {
          const base = Array.isArray(prev) ? prev : [];
          const idx = base.findIndex((x) => x.skillId === skillId);
          if (idx < 0) return prev;
          const item = base[idx];
          if (!item) return prev;
          if (item.versionPolicy !== "pinned") return prev;
          if (item.pinnedVersionId) return prev;
          const first = vs[0]?.id ?? null;
          if (!first) return prev;
          const next = [...base];
          next[idx] = { ...item, pinnedVersionId: first };
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreateSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [createSkillVersionsById, listSkillVersions, requireAdmin, setError],
  );

  useEffect(() => {
    if (!active) return;
    for (const it of roleSkills) {
      if (it.versionPolicy !== "pinned") continue;
      if (roleSkillVersionsById[it.skillId]) continue;
      void ensureRoleSkillVersions(it.skillId);
    }
  }, [active, ensureRoleSkillVersions, roleSkillVersionsById, roleSkills]);

  useEffect(() => {
    if (!active) return;
    const items = Array.isArray(roleCreateSkillsDraft) ? roleCreateSkillsDraft : [];
    for (const it of items) {
      if (it.versionPolicy !== "pinned") continue;
      if (createSkillVersionsById[it.skillId]) continue;
      void ensureCreateRoleSkillVersions(it.skillId);
    }
  }, [active, createSkillVersionsById, ensureCreateRoleSkillVersions, roleCreateSkillsDraft]);

  const removeRoleSkill = useCallback((skillId: string) => {
    setRoleSkills((prev) => prev.filter((x) => x.skillId !== skillId));
  }, []);

  const removeCreateRoleSkill = useCallback((skillId: string) => {
    setRoleCreateSkillsDraft((prev) =>
      Array.isArray(prev) ? prev.filter((x) => x.skillId !== skillId) : prev,
    );
  }, []);

  const onSaveRoleSkills = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId || !roleEditingId) return;

    const missingPinned = roleSkills.filter(
      (x) => x.versionPolicy === "pinned" && !x.pinnedVersionId,
    );
    if (missingPinned.length) {
      setError("存在 pinned 技能未选择版本，请先选择 pinnedVersionId");
      for (const it of missingPinned) {
        void ensureRoleSkillVersions(it.skillId);
      }
      return;
    }

    setRoleSkillsSaving(true);
    try {
      const res = await putRoleSkills(
        effectiveProjectId,
        roleEditingId,
        roleSkills.map((x) => ({
          skillId: x.skillId,
          versionPolicy: x.versionPolicy,
          ...(x.pinnedVersionId ? { pinnedVersionId: x.pinnedVersionId } : {}),
          enabled: x.enabled,
        })),
      );
      setRoleSkills(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleSkillsSaving(false);
    }
  }, [
    effectiveProjectId,
    ensureRoleSkillVersions,
    putRoleSkills,
    requireAdmin,
    roleEditingId,
    roleSkills,
    setError,
  ]);

  const makeAgentInputId = useCallback(() => {
    const raw =
      typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
        ? String((globalThis.crypto as any).randomUUID())
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return (
      raw
        .replace(/[^a-z0-9]+/gi, "")
        .toLowerCase()
        .slice(0, 8) || "input"
    );
  }, []);

  const normalizeItemForApply = useCallback(
    (apply: AgentInputsApply, item: AgentInputItem): AgentInputItem => {
      if (apply === "writeFile") {
        const src =
          item.source.type === "inlineText"
            ? item.source
            : { type: "inlineText" as const, text: "" };
        return { ...item, apply, source: src };
      }
      if (apply === "downloadExtract") {
        const src =
          item.source.type === "httpZip" ? item.source : { type: "httpZip" as const, uri: "" };
        return { ...item, apply, source: src };
      }
      if (apply === "copy" || apply === "bindMount") {
        const src =
          item.source.type === "hostPath" ? item.source : { type: "hostPath" as const, path: "" };
        const next: AgentInputItem = { ...item, apply, source: src };
        if (apply === "bindMount") {
          return { ...next, target: { root: "WORKSPACE", path: "." } };
        }
        return next;
      }
      return { ...item, apply };
    },
    [],
  );

  const onSaveAgentInputs = useCallback(async () => {
    setError(null);
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);
    if (!effectiveProjectId || !roleEditingId) return;

    setRoleAgentInputsSaving(true);
    try {
      const role = await updateRole(effectiveProjectId, roleEditingId, {
        agentInputs: roleAgentInputs,
      });
      setRoles((prev) => prev.map((r) => (r.id === role.id ? role : r)));
    } catch (err) {
      setRoleAgentInputsError(err instanceof Error ? err.message : String(err));
      setRoleAgentInputsErrorDetails((err as any)?.details ?? null);
    } finally {
      setRoleAgentInputsSaving(false);
    }
  }, [effectiveProjectId, roleAgentInputs, roleEditingId, setError]);

  const onStartCreate = useCallback(() => {
    resetRoleEdit();
    setRoleKey("");
    setRoleDisplayName("");
    setRoleDescription("");
    setRolePromptTemplate("");
    setRoleInitScript("");
    setRoleInitTimeoutSeconds("300");
    setRoleEnvText("");
    setRoleCreateAgentInputs(undefined);
    setRoleCreateSkillsDraft(null);
    setCreateSkillsSearchQ("");
    setCreateSkillsSearchLoading(false);
    setCreateSkillsSearchError(null);
    setCreateSkillsSearchResults([]);
    setCreateSkillVersionsById({});
    setCreateSkillVersionsLoadingById({});
    setCreateAgentInputsSelectedId("");
    queueMicrotask(() => roleCreateKeyRef.current?.focus());
  }, [resetRoleEdit]);

  const createSkills = Array.isArray(roleCreateSkillsDraft) ? roleCreateSkillsDraft : [];
  const setCreateSkills = useCallback((updater: (prev: RoleSkillItem[]) => RoleSkillItem[]) => {
    setRoleCreateSkillsDraft((prev) => {
      const base = Array.isArray(prev) ? prev : [];
      return updater(base);
    });
  }, []);

  const createAgentFilesManifest: AgentInputsManifestV1 = useMemo(() => {
    if (roleCreateAgentInputs && typeof roleCreateAgentInputs === "object")
      return roleCreateAgentInputs;
    return { version: 1, items: [] };
  }, [roleCreateAgentInputs]);

  const setCreateAgentFilesManifest = useCallback(
    (updater: (prev: AgentInputsManifestV1) => AgentInputsManifestV1) => {
      setRoleCreateAgentInputs((prev) => {
        const base =
          prev && typeof prev === "object" ? prev : ({ version: 1, items: [] } as AgentInputsManifestV1);
        return updater(base);
      });
    },
    [],
  );

  const createAgentsMd = useMemo(
    () => getAgentsMdInlineText(createAgentFilesManifest)?.text ?? "",
    [createAgentFilesManifest],
  );

  const onChangeCreateAgentsMd = useCallback(
    (next: string) => {
      setRolePromptTemplate(next);
      setRoleCreateAgentInputs((prev) => {
        const base =
          prev && typeof prev === "object" ? prev : { version: 1 as const, items: [] as AgentInputItem[] };
        const { manifest, id } = upsertAgentsMdInlineText({
          manifest: base,
          text: next,
          makeAgentInputId,
        });
        queueMicrotask(() => setCreateAgentInputsSelectedId(id));
        return manifest;
      });
    },
    [makeAgentInputId],
  );

  const editAgentsMd = useMemo(() => {
    const found = getAgentsMdInlineText(roleAgentInputs);
    return found?.text ?? roleEditPromptTemplate;
  }, [roleAgentInputs, roleEditPromptTemplate]);

  const onChangeEditAgentsMd = useCallback(
    (next: string) => {
      setRoleEditPromptTemplate(next);
      setRoleAgentInputs((prev) => {
        const { manifest, id } = upsertAgentsMdInlineText({
          manifest: prev,
          text: next,
          makeAgentInputId,
        });
        queueMicrotask(() => setRoleAgentInputsSelectedId(id));
        return manifest;
      });
    },
    [makeAgentInputId],
  );

  return (
    <section className="card" hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>角色模板</h2>
          <div className="muted">维护 Prompt / initScript / envText / 超时等配置。</div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onStartCreate}
            disabled={!effectiveProjectId || rolesLoading}
          >
            新建
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refreshRoles()}
            disabled={!effectiveProjectId || rolesLoading}
          >
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
              <div className="muted">
                {filteredRoles.length ? `显示 ${filteredRoles.length} / ${roles.length}` : "—"}
              </div>
            </div>

            <label className="label" style={{ marginTop: 10 }}>
              搜索
              <Input
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
                placeholder="按 key / 名称 / env keys 过滤…"
              />
            </label>

            <div className="tableScroll" style={{ marginTop: 12, maxHeight: 520 }}>
              {filteredRoles.length ? (
                <ul className="list" style={{ marginTop: 0 }}>
                  {filteredRoles.map((role) => {
                    const selected = roleEditingId === role.id;
                    const busy = roleSavingId === role.id || roleDeletingId === role.id;
                    return (
                      <li
                        key={role.id}
                        className={`listItem adminListItem ${selected ? "selected" : ""}`}
                      >
                        <div
                          className="adminListItemButton"
                          onClick={() => {
                            if (busy) return;
                            startRoleEdit(role);
                          }}
                          role="button"
                          tabIndex={busy ? -1 : 0}
                          aria-disabled={busy}
                          onKeyDown={(e) => {
                            if (busy) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              startRoleEdit(role);
                            }
                          }}
                        >
                          <div
                            className="row spaceBetween"
                            style={{ gap: 10, alignItems: "center" }}
                          >
                            <div className="cellStack" style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 800 }}>{role.displayName ?? role.key}</div>
                              <div className="cellSub">
                                <code>{role.key}</code> · {role.initTimeoutSeconds}s ·{" "}
                                {new Date(role.updatedAt).toLocaleString()}
                              </div>
                              {role.description ? (
                                <div className="cellSub">{role.description}</div>
                              ) : null}
                              {role.envKeys?.length ? (
                                <div className="cellSub">env: {role.envKeys.join(", ")}</div>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                resetRoleEdit();
                                copyRoleToCreate(role);
                              }}
                              disabled={busy}
                              title="复制为新角色"
                            >
                              复制
                            </Button>
                          </div>
                        </div>
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
              <div className="stack" style={{ gap: 16 }}>
                <form onSubmit={(e) => void onUpdateRole(e)} className="form">
                  <div
                    className="row spaceBetween"
                    style={{ alignItems: "baseline", flexWrap: "wrap" }}
                  >
                    <div>
                      <h3 style={{ marginTop: 0, marginBottom: 4 }}>编辑角色</h3>
                      <div className="muted">
                        key: <code>{editingRole.key}</code> · id: <code>{editingRole.id}</code>
                      </div>
                    </div>
                    <div
                      className="row gap"
                      style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={copyEditingRoleToCreate}
                        disabled={
                          roleSavingId === editingRole.id || roleDeletingId === editingRole.id
                        }
                      >
                        复制为新角色
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void onDeleteRole(editingRole)}
                        disabled={
                          roleSavingId === editingRole.id || roleDeletingId === editingRole.id
                        }
                      >
                        {roleDeletingId === editingRole.id ? "删除中…" : "删除"}
                      </Button>
                    </div>
                  </div>

                  <RoleTemplateManageForm
                    mode="edit"
                    roleKey={editingRole.key}
                    roleKeyReadOnly
                    displayName={roleEditDisplayName}
                    onDisplayNameChange={setRoleEditDisplayName}
                    description={roleEditDescription}
                    onDescriptionChange={setRoleEditDescription}
                    promptTemplate={roleEditPromptTemplate}
                    onPromptTemplateChange={setRoleEditPromptTemplate}
                    agentsMdText={editAgentsMd}
                    onAgentsMdTextChange={onChangeEditAgentsMd}
                    initScript={roleEditInitScript}
                    onInitScriptChange={setRoleEditInitScript}
                    initTimeoutSeconds={roleEditInitTimeoutSeconds}
                    onInitTimeoutSecondsChange={setRoleEditInitTimeoutSeconds}
                    envText={roleEditEnvText}
                    onEnvTextChange={setRoleEditEnvText}
                    envTextEnabled={roleEditEnvTextEnabled}
                    onEnvTextEnabledChange={setRoleEditEnvTextEnabled}
                    envKeysHint={editingRole.envKeys ?? null}
                    submitLabel="保存修改"
                    submitBusy={roleSavingId === editingRole.id}
                    submitDisabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}
                    onCancel={resetRoleEdit}
                  />
                </form>

                <RoleSkillsCard
                  title="Skills"
                  subtitle="该角色运行时允许加载的 skills 集合（一期仅配置；后续实现挂载）。"
                  loading={roleSkillsLoading}
                  loadError={roleSkillsError}
                  saving={roleSkillsSaving}
                  onSave={() => void onSaveRoleSkills()}
                  skills={roleSkills}
                  setSkills={(updater) => setRoleSkills((prev) => updater(prev))}
                  searchQ={roleSkillsSearchQ}
                  onSearchQChange={setRoleSkillsSearchQ}
                  searchLoading={roleSkillsSearchLoading}
                  searchError={roleSkillsSearchError}
                  searchResults={roleSkillsSearchResults}
                  onSearch={() => void onRoleSkillsSearch()}
                  onAddSkill={addRoleSkill}
                  onRemoveSkill={removeRoleSkill}
                  versionsById={roleSkillVersionsById}
                  versionsLoadingById={roleSkillVersionsLoadingById}
                  ensureVersions={(skillId) => void ensureRoleSkillVersions(skillId)}
                />

                <RoleAgentFilesCard
                  title="Agent 文件"
                  subtitle="按 items 顺序执行，落到该 run 的 WORKSPACE / USER_HOME。"
                  manifest={roleAgentInputs}
                  setManifest={(updater) => setRoleAgentInputs((prev) => updater(prev))}
                  selectedId={roleAgentInputsSelectedId}
                  onSelectedIdChange={setRoleAgentInputsSelectedId}
                  onSave={() => void onSaveAgentInputs()}
                  saving={roleAgentInputsSaving}
                  error={roleAgentInputsError}
                  errorDetails={roleAgentInputsErrorDetails}
                  setError={setError}
                  agentInputsInlineFileRef={agentInputsInlineFileRef}
                  makeAgentInputId={makeAgentInputId}
                  normalizeItemForApply={normalizeItemForApply}
                />

                {/*
                <details open style={{ borderTop: "1px solid var(--card-border)", paddingTop: 16 }}>
                  <summary style={{ cursor: "pointer" }}>
                    <div
                      className="row spaceBetween"
                      style={{ alignItems: "baseline", flexWrap: "wrap" }}
                    >
                      <div>
                        <h3 style={{ marginTop: 0, marginBottom: 4 }}>Agent 文件</h3>
                        <div className="muted">
                          按 items 顺序执行，落到该 run 的 WORKSPACE / USER_HOME。
                        </div>
                      </div>
                      <div className="muted">点击展开/收起</div>
                    </div>
                  </summary>

                  <div
                    className="row gap"
                    style={{ justifyContent: "flex-end", flexWrap: "wrap", marginTop: 10 }}
                  >
                    <Button type="button" variant="secondary" size="sm" onClick={onAddAgentInput}>
                      新增
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={onCopyAgentInput}
                      disabled={!selectedAgentInput}
                    >
                      复制
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={onDeleteAgentInput}
                      disabled={!selectedAgentInput}
                    >
                      删除
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onMoveAgentInput(-1)}
                      disabled={selectedAgentInputIndex <= 0}
                    >
                      上移
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => onMoveAgentInput(1)}
                      disabled={
                        selectedAgentInputIndex < 0 ||
                        selectedAgentInputIndex >= roleAgentInputs.items.length - 1
                      }
                    >
                      下移
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void onSaveAgentInputs()}
                      disabled={roleAgentInputsSaving}
                    >
                      {roleAgentInputsSaving ? "保存中…" : "保存 Agent 文件"}
                    </Button>
                  </div>

                  {roleAgentInputsError ? (
                    <div className="muted" style={{ marginTop: 10 }} title={roleAgentInputsError}>
                      Agent 文件保存失败：{roleAgentInputsError}
                    </div>
                  ) : null}
                  {roleAgentInputsErrorDetails ? (
                    <pre className="pre" style={{ marginTop: 10 }}>
                      {JSON.stringify(roleAgentInputsErrorDetails, null, 2)}
                    </pre>
                  ) : null}

                  <div
                    className="row"
                    style={{ marginTop: 12, gap: 12, alignItems: "stretch", flexWrap: "wrap" }}
                  >
                    <div
                      className="rounded-lg border bg-card p-4"
                      style={{ flex: 1, minWidth: 380 }}
                    >
                      <div className="row spaceBetween" style={{ gap: 10, alignItems: "baseline" }}>
                        <div style={{ fontWeight: 800 }}>items</div>
                        <div className="muted">
                          {roleAgentInputs.items.length
                            ? `共 ${roleAgentInputs.items.length} 项`
                            : "—"}
                        </div>
                      </div>

                      <div
                        className="row"
                        style={{ marginTop: 10, gap: 10, fontSize: 12, fontWeight: 700 }}
                      >
                        <div style={{ flex: 1.3, minWidth: 0 }}>名称</div>
                        <div style={{ width: 120 }}>apply</div>
                        <div style={{ width: 110 }}>root</div>
                        <div style={{ flex: 2, minWidth: 0 }}>target.path</div>
                        <div style={{ width: 120 }}>source</div>
                      </div>

                      <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                        {roleAgentInputs.items.length ? (
                          roleAgentInputs.items.map((it) => {
                            const selected = it.id === roleAgentInputsSelectedId;
                            const srcType = (it.source as any)?.type ?? "—";
                            const name =
                              typeof (it as any)?.name === "string"
                                ? String((it as any).name).trim()
                                : "";
                            return (
                              <div
                                key={it.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedAgentInput(it.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setSelectedAgentInput(it.id);
                                  }
                                }}
                                style={{
                                  border: "1px solid var(--card-border)",
                                  borderColor: selected ? "var(--primary)" : "var(--card-border)",
                                  borderRadius: 12,
                                  padding: 10,
                                  cursor: "pointer",
                                  background: "var(--list-bg)",
                                }}
                              >
                                <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
                                  <div
                                    style={{
                                      flex: 1.3,
                                      minWidth: 0,
                                      fontSize: 12,
                                      fontWeight: 800,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                    title={name || ""}
                                  >
                                    {name || "—"}
                                  </div>
                                  <div style={{ width: 120, fontSize: 12 }}>{it.apply}</div>
                                  <div style={{ width: 110, fontSize: 12 }}>
                                    {it.target?.root ?? "—"}
                                  </div>
                                  <div
                                    style={{
                                      flex: 2,
                                      minWidth: 0,
                                      fontSize: 12,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                    title={it.target?.path ?? ""}
                                  >
                                    {it.target?.path ?? ""}
                                  </div>
                                  <div style={{ width: 120, fontSize: 12 }}>{srcType}</div>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="muted">暂无 items，点击“新增”创建。</div>
                        )}
                      </div>
                    </div>

                    <div
                      className="rounded-lg border bg-card p-4"
                      style={{ flex: 1, minWidth: 380 }}
                    >
                      <div className="row spaceBetween" style={{ gap: 10, alignItems: "baseline" }}>
                        <div style={{ fontWeight: 800 }}>详情</div>
                        <div className="muted">
                          {selectedAgentInput ? `编辑：${selectedAgentInput.id}` : "—"}
                        </div>
                      </div>

                      {selectedAgentInput ? (
                        <div className="stack" style={{ gap: 12, marginTop: 10 }}>
                          <label className="label">
                            名称（可选）
                            <Input
                              value={(selectedAgentInput as any).name ?? ""}
                              onChange={(e) => {
                                const v = e.target.value.trim();
                                updateSelectedAgentInput((prev) => ({
                                  ...prev,
                                  ...(v ? { name: v } : { name: undefined }),
                                }));
                              }}
                              placeholder="例如：AGENTS.md / config.toml"
                            />
                          </label>

                          <label className="label">
                            apply *
                            <Select
                              value={selectedAgentInput.apply}
                              onValueChange={(v) =>
                                updateSelectedAgentInput((prev) =>
                                  normalizeItemForApply(v as AgentInputsApply, prev),
                                )
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="选择 apply" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="writeFile">writeFile</SelectItem>
                                <SelectItem value="downloadExtract">downloadExtract</SelectItem>
                                <SelectItem value="copy">copy</SelectItem>
                                <SelectItem value="bindMount">bindMount</SelectItem>
                              </SelectContent>
                            </Select>
                          </label>

                          <div
                            className="row gap"
                            style={{ alignItems: "center", flexWrap: "wrap" }}
                          >
                            <label className="label" style={{ flex: 1, minWidth: 200 }}>
                              target.root *
                              <Select
                                value={
                                  (selectedAgentInput.target?.root ??
                                    "WORKSPACE") as AgentInputsTargetRoot
                                }
                                onValueChange={(v) =>
                                  updateSelectedAgentInput((prev) => ({
                                    ...prev,
                                    target: {
                                      ...(prev.target as any),
                                      root: v as AgentInputsTargetRoot,
                                    },
                                  }))
                                }
                              >
                                <SelectTrigger disabled={selectedAgentInput.apply === "bindMount"}>
                                  <SelectValue placeholder="选择 root" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="WORKSPACE">WORKSPACE</SelectItem>
                                  <SelectItem value="USER_HOME">USER_HOME</SelectItem>
                                </SelectContent>
                              </Select>
                            </label>

                            <label className="label" style={{ flex: 2, minWidth: 260 }}>
                              target.path *
                              <Input
                                value={selectedAgentInput.target?.path ?? ""}
                                onChange={(e) =>
                                  updateSelectedAgentInput((prev) => ({
                                    ...prev,
                                    target: { ...(prev.target as any), path: e.target.value },
                                  }))
                                }
                                disabled={selectedAgentInput.apply === "bindMount"}
                                placeholder={
                                  selectedAgentInput.apply === "bindMount"
                                    ? "."
                                    : ".codex/AGENTS.md"
                                }
                              />
                            </label>
                          </div>

                          {selectedAgentInput.source.type === "hostPath" ? (
                            <label className="label">
                              source.hostPath
                              <Input
                                value={selectedAgentInput.source.path ?? ""}
                                onChange={(e) =>
                                  updateSelectedAgentInput((prev) => ({
                                    ...prev,
                                    source: {
                                      ...(prev.source as any),
                                      type: "hostPath",
                                      path: e.target.value,
                                    },
                                  }))
                                }
                                placeholder="C:\\path\\to\\file-or-dir"
                              />
                            </label>
                          ) : null}

                          {selectedAgentInput.source.type === "httpZip" ? (
                            <div className="stack" style={{ gap: 12 }}>
                              <label className="label">
                                source.httpZip.uri
                                <Input
                                  value={selectedAgentInput.source.uri ?? ""}
                                  onChange={(e) =>
                                    updateSelectedAgentInput((prev) => ({
                                      ...prev,
                                      source: {
                                        ...(prev.source as any),
                                        type: "httpZip",
                                        uri: e.target.value,
                                      },
                                    }))
                                  }
                                  placeholder="/api/acp-proxy/skills/<...>.zip"
                                />
                              </label>
                              <label className="label">
                                source.httpZip.contentHash（可选）
                                <Input
                                  value={(selectedAgentInput.source as any).contentHash ?? ""}
                                  onChange={(e) => {
                                    const v = e.target.value.trim();
                                    updateSelectedAgentInput((prev) => ({
                                      ...prev,
                                      source: {
                                        ...(prev.source as any),
                                        type: "httpZip",
                                        ...(v ? { contentHash: v } : { contentHash: undefined }),
                                      },
                                    }));
                                  }}
                                  placeholder="sha256:..."
                                />
                              </label>
                            </div>
                          ) : null}

                          {selectedAgentInput.source.type === "inlineText" ? (
                            <label className="label">
                              source.inlineText.text
                              <div
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const f = e.dataTransfer?.files?.[0];
                                  if (!f) return;
                                  if (typeof f.text !== "function") return;
                                  if (f.size > 512 * 1024) {
                                    setError("文件过大：最多支持 512KB 文本文件");
                                    return;
                                  }
                                  void f.text().then((text) => {
                                    updateSelectedAgentInput((prev) => ({
                                      ...prev,
                                      source: { ...(prev.source as any), type: "inlineText", text },
                                    }));
                                  });
                                }}
                                style={{
                                  border: "1px dashed var(--card-border)",
                                  borderRadius: 12,
                                  padding: 10,
                                  background: "color-mix(in oklab, var(--card), transparent 0%)",
                                }}
                              >
                                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                                  可直接把文本文件（.md/.txt/.toml 等）拖到这里，会自动读取并填入。
                                </div>
                                <Textarea
                                  aria-label="source.inlineText.text"
                                  value={selectedAgentInput.source.text ?? ""}
                                  onChange={(e) =>
                                    updateSelectedAgentInput((prev) => ({
                                      ...prev,
                                      source: {
                                        ...(prev.source as any),
                                        type: "inlineText",
                                        text: e.target.value,
                                      },
                                    }))
                                  }
                                  rows={12}
                                  placeholder={
                                    "# e.g. .codex/AGENTS.md\n你在 Windows PowerShell（pwsh）环境中工作，回答我的时候一律中文。\\n"
                                  }
                                />
                                <input
                                  type="file"
                                  accept="text/*,.md,.txt,.toml,.json,.yaml,.yml,.env"
                                  style={{ display: "none" }}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (!f) return;
                                    if (typeof f.text !== "function") return;
                                    if (f.size > 512 * 1024) {
                                      setError("文件过大：最多支持 512KB 文本文件");
                                      return;
                                    }
                                    void f.text().then((text) => {
                                      updateSelectedAgentInput((prev) => ({
                                        ...prev,
                                        source: {
                                          ...(prev.source as any),
                                          type: "inlineText",
                                          text,
                                        },
                                      }));
                                    });
                                  }}
                                  ref={agentInputsInlineFileRef}
                                />
                                <div className="row gap" style={{ marginTop: 8, flexWrap: "wrap" }}>
                                  <Button
                                    type="button"
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                      agentInputsInlineFileRef.current?.click();
                                    }}
                                  >
                                    选择文件
                                  </Button>
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    注意：不会上传文件，只是在浏览器读取内容后填入文本框。
                                  </div>
                                </div>
                              </div>
                            </label>
                          ) : null}

                          <div className="muted" style={{ fontSize: 12 }}>
                            顺序即执行顺序；`name` 只是展示用；`id`
                            为内部标识（自动生成，不可编辑）；`target.path` 必须是相对路径且不得包含
                            `..`。
                          </div>
                        </div>
                      ) : (
                        <div className="muted" style={{ marginTop: 10 }}>
                          选择左侧某个 item 以编辑。
                        </div>
                      )}
                    </div>
                  </div>
                </details>
                */}
              </div>
            ) : (
              <div className="stack" style={{ gap: 16 }}>
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: 4 }}>创建 RoleTemplate</h3>
                  <div className="muted">建议先从现有角色“复制为新角色”。</div>
                </div>

                <form onSubmit={(e) => void onCreateRole(e)} className="form">
                  <RoleTemplateManageForm
                    mode="create"
                    roleKey={roleKey}
                    roleKeyInputRef={roleCreateKeyRef}
                    onRoleKeyChange={setRoleKey}
                    displayName={roleDisplayName}
                    onDisplayNameChange={setRoleDisplayName}
                    description={roleDescription}
                    onDescriptionChange={setRoleDescription}
                    promptTemplate={rolePromptTemplate}
                    onPromptTemplateChange={setRolePromptTemplate}
                    agentsMdText={createAgentsMd}
                    onAgentsMdTextChange={onChangeCreateAgentsMd}
                    initScript={roleInitScript}
                    onInitScriptChange={setRoleInitScript}
                    initTimeoutSeconds={roleInitTimeoutSeconds}
                    onInitTimeoutSecondsChange={setRoleInitTimeoutSeconds}
                    envText={roleEnvText}
                    onEnvTextChange={setRoleEnvText}
                    submitLabel="创建"
                    submitDisabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}
                    onCancel={onStartCreate}
                    onClear={onStartCreate}
                  >
                    <div className="stack" style={{ gap: 16 }}>
                      <RoleSkillsCard
                        title="Skills"
                        subtitle="创建后会在该角色上保存 skills 配置。"
                        skills={createSkills}
                        setSkills={setCreateSkills}
                        searchQ={createSkillsSearchQ}
                        onSearchQChange={setCreateSkillsSearchQ}
                        searchLoading={createSkillsSearchLoading}
                        searchError={createSkillsSearchError}
                        searchResults={createSkillsSearchResults}
                        onSearch={() => void onCreateRoleSkillsSearch()}
                        onAddSkill={addCreateRoleSkill}
                        onRemoveSkill={removeCreateRoleSkill}
                        versionsById={createSkillVersionsById}
                        versionsLoadingById={createSkillVersionsLoadingById}
                        ensureVersions={(skillId) => void ensureCreateRoleSkillVersions(skillId)}
                      />

                      <RoleAgentFilesCard
                        title="Agent 文件"
                        subtitle="按 items 顺序执行，落到该 run 的 WORKSPACE / USER_HOME。"
                        statusHint={
                          roleCreateAgentInputs === undefined
                            ? "未配置：创建时不会携带该字段。"
                            : roleCreateAgentInputs === null
                              ? "未配置：当前值为 null。"
                              : undefined
                        }
                        manifest={createAgentFilesManifest}
                        setManifest={setCreateAgentFilesManifest}
                        selectedId={createAgentInputsSelectedId}
                        onSelectedIdChange={setCreateAgentInputsSelectedId}
                        setError={setError}
                        agentInputsInlineFileRef={agentInputsInlineFileRef}
                        makeAgentInputId={makeAgentInputId}
                        normalizeItemForApply={normalizeItemForApply}
                      />
                    </div>
                  </RoleTemplateManageForm>
                </form>

                <div className="muted" style={{ marginTop: 2 }}>
                  复制为新角色：仅需填写新的 <code>Role Key</code>，其余字段将沿用；已加载的 Skills /
                  Agent 文件配置也会一并复制。
                </div>

                {/*
              <form onSubmit={(e) => void onCreateRole(e)} className="form">
                <h3 style={{ marginTop: 0, marginBottom: 4 }}>创建 RoleTemplate</h3>
                <div className="muted">建议先从现有角色“复制为新角色”</div>

                <label className="label">
                  Role Key *
                  <Input
                    ref={roleCreateKeyRef}
                    value={roleKey}
                    onChange={(e) => setRoleKey(e.target.value)}
                    placeholder="backend-dev"
                  />
                </label>
                <label className="label">
                  显示名称 *
                  <Input
                    value={roleDisplayName}
                    onChange={(e) => setRoleDisplayName(e.target.value)}
                    placeholder="后端开发"
                  />
                </label>
                <label className="label">
                  描述（可选）
                  <Input
                    value={roleDescription}
                    onChange={(e) => setRoleDescription(e.target.value)}
                    placeholder="用于选择/提示的简短说明"
                  />
                </label>
                <label className="label">
                  Prompt Template（可选）
                  <Textarea
                    value={rolePromptTemplate}
                    onChange={(e) => setRolePromptTemplate(e.target.value)}
                    placeholder="你是 {{role.name}}，请优先写单测。"
                  />
                </label>
                <label className="label">
                  initScript（bash，可选）
                  <Textarea
                    value={roleInitScript}
                    onChange={(e) => setRoleInitScript(e.target.value)}
                    placeholder={"# 可使用环境变量：GH_TOKEN/TUIXIU_WORKSPACE 等\n\necho init"}
                  />
                </label>
                <label className="label">
                  init 超时秒数（可选）
                  <Input
                    value={roleInitTimeoutSeconds}
                    onChange={(e) => setRoleInitTimeoutSeconds(e.target.value)}
                    placeholder="300"
                  />
                </label>
                <label className="label">
                  envText（.env，可选）
                  <Textarea
                    value={roleEnvText}
                    onChange={(e) => setRoleEnvText(e.target.value)}
                    rows={4}
                    placeholder={"FOO=bar\nexport TOKEN=xxx"}
                  />
                </label>
                <div className="row gap" style={{ marginTop: 10, flexWrap: "wrap" }}>
                  <Button
                    type="submit"
                    disabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}
                  >
                    创建
                  </Button>
                  <Button type="button" variant="secondary" onClick={onStartCreate}>
                    清空
                  </Button>
                </div>

                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 800 }}>
                    Skills（新建时可配置）
                  </summary>
                  <div style={{ marginTop: 10 }}>
                    {!Array.isArray(roleCreateSkillsDraft) ? (
                      <div
                        className="row spaceBetween"
                        style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <div className="muted">当前未配置 skills。点击右侧启用后可搜索并添加。</div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setRoleCreateSkillsDraft([])}
                        >
                          启用 Skills
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div
                          className="row gap"
                          style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
                        >
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void onCreateRoleSkillsSearch()}
                            disabled={createSkillsSearchLoading}
                          >
                            {createSkillsSearchLoading ? "搜索中…" : "搜索"}
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setRoleCreateSkillsDraft(null)}
                          >
                            不使用 Skills
                          </Button>
                        </div>

                        {roleCreateSkillsDraft.length ? (
                          <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
                            {roleCreateSkillsDraft.map((s) => (
                              <div
                                key={s.skillId}
                                className="row"
                                style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
                              >
                                <Badge variant="outline">{s.name || s.skillId}</Badge>

                                <Select
                                  value={s.versionPolicy}
                                  onValueChange={(v) => {
                                    const nextPolicy = v === "pinned" ? "pinned" : "latest";
                                    setRoleCreateSkillsDraft((prev) => {
                                      const base = Array.isArray(prev) ? prev : [];
                                      return base.map((x) =>
                                        x.skillId === s.skillId
                                          ? {
                                              ...x,
                                              versionPolicy: nextPolicy,
                                              pinnedVersionId:
                                                nextPolicy === "pinned" ? x.pinnedVersionId : null,
                                            }
                                          : x,
                                      );
                                    });
                                    if (nextPolicy === "pinned")
                                      void ensureCreateRoleSkillVersions(s.skillId);
                                  }}
                                >
                                  <SelectTrigger className="w-[160px]">
                                    <SelectValue placeholder="版本策略" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="latest">latest</SelectItem>
                                    <SelectItem value="pinned">pinned</SelectItem>
                                  </SelectContent>
                                </Select>

                                {s.versionPolicy === "pinned" ? (
                                  <Select
                                    value={s.pinnedVersionId ?? ""}
                                    onValueChange={(v) =>
                                      setRoleCreateSkillsDraft((prev) => {
                                        const base = Array.isArray(prev) ? prev : [];
                                        return base.map((x) =>
                                          x.skillId === s.skillId
                                            ? { ...x, pinnedVersionId: v }
                                            : x,
                                        );
                                      })
                                    }
                                  >
                                    <SelectTrigger
                                      className="w-[260px]"
                                      disabled={createSkillVersionsLoadingById[s.skillId] === true}
                                    >
                                      <SelectValue
                                        placeholder={
                                          createSkillVersionsLoadingById[s.skillId] === true
                                            ? "加载版本中…"
                                            : "选择版本"
                                        }
                                      />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {(createSkillVersionsById[s.skillId] ?? []).map((v) => (
                                        <SelectItem key={v.id} value={v.id}>
                                          {new Date(v.importedAt).toLocaleString()} ·{" "}
                                          {v.contentHash.slice(0, 8)}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                ) : null}

                                <label className="row" style={{ gap: 8, alignItems: "center" }}>
                                  <Checkbox
                                    checked={s.enabled}
                                    onCheckedChange={(v) =>
                                      setRoleCreateSkillsDraft((prev) => {
                                        const base = Array.isArray(prev) ? prev : [];
                                        return base.map((x) =>
                                          x.skillId === s.skillId
                                            ? { ...x, enabled: v === true }
                                            : x,
                                        );
                                      })
                                    }
                                  />
                                  <span className="muted">启用</span>
                                </label>

                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => removeCreateRoleSkill(s.skillId)}
                                >
                                  移除
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="muted" style={{ marginTop: 10 }}>
                            已启用 Skills，但还未添加任何条目。
                          </div>
                        )}

                        <div
                          className="row gap"
                          style={{ marginTop: 12, alignItems: "center", flexWrap: "wrap" }}
                        >
                          <Input
                            value={createSkillsSearchQ}
                            onChange={(e) => setCreateSkillsSearchQ(e.target.value)}
                            placeholder="搜索 registry skills…"
                          />
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={() => void onCreateRoleSkillsSearch()}
                            disabled={createSkillsSearchLoading}
                          >
                            {createSkillsSearchLoading ? "搜索中…" : "搜索 registry"}
                          </Button>
                        </div>

                        {createSkillsSearchError ? (
                          <div
                            className="muted"
                            style={{ marginTop: 10 }}
                            title={createSkillsSearchError}
                          >
                            skills 搜索失败：{createSkillsSearchError}
                          </div>
                        ) : null}

                        {createSkillsSearchResults.length ? (
                          <ul className="list" style={{ marginTop: 12 }}>
                            {createSkillsSearchResults.map((it) => {
                              const already = roleCreateSkillsDraft.some(
                                (x) => x.skillId === it.skillId,
                              );
                              return (
                                <li key={it.skillId} className="listItem">
                                  <div
                                    className="row spaceBetween"
                                    style={{ gap: 10, alignItems: "center" }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ fontWeight: 800 }}>{it.name}</div>
                                      <div className="muted">
                                        <code>{it.skillId}</code>
                                      </div>
                                    </div>
                                    <Button
                                      type="button"
                                      size="sm"
                                      onClick={() => addCreateRoleSkill(it)}
                                      disabled={already}
                                    >
                                      {already ? "已添加" : "添加"}
                                    </Button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </>
                    )}
                  </div>
                </details>

                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 800 }}>
                    Agent 文件（新建时可配置）
                  </summary>
                  <div style={{ marginTop: 10 }}>
                    {roleCreateAgentInputs === undefined ? (
                      <div
                        className="row spaceBetween"
                        style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <div className="muted">当前未配置 Agent 文件。点击右侧启用后可编辑。</div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setRoleCreateAgentInputs({ version: 1, items: [] })}
                        >
                          启用 Agent 文件
                        </Button>
                      </div>
                    ) : roleCreateAgentInputs === null ? (
                      <div
                        className="row spaceBetween"
                        style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}
                      >
                        <div className="muted">当前设置为不使用 Agent 文件。</div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => setRoleCreateAgentInputs({ version: 1, items: [] })}
                        >
                          启用 Agent 文件
                        </Button>
                      </div>
                    ) : (
                      <div className="stack" style={{ gap: 12 }}>
                        <div
                          className="row gap"
                          style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
                        >
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              const id = `agents-md-${makeAgentInputId()}`;
                              const nextItem: AgentInputItem = {
                                id,
                                name: "AGENTS.md",
                                apply: "writeFile",
                                access: "rw",
                                source: { type: "inlineText", text: "" },
                                target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
                              };
                              setRoleCreateAgentInputs((prev) =>
                                prev && typeof prev === "object"
                                  ? { ...(prev as any), items: [...(prev as any).items, nextItem] }
                                  : prev,
                              );
                              setCreateAgentInputsSelectedId(id);
                            }}
                          >
                            新增
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setRoleCreateAgentInputs(null)}
                          >
                            不使用 Agent 文件
                          </Button>
                        </div>

                        <div
                          className="row"
                          style={{ gap: 12, alignItems: "stretch", flexWrap: "wrap" }}
                        >
                          <div
                            className="rounded-lg border bg-card p-4"
                            style={{ flex: 1, minWidth: 380 }}
                          >
                            <div
                              className="row spaceBetween"
                              style={{ gap: 10, alignItems: "baseline" }}
                            >
                              <div style={{ fontWeight: 800 }}>items</div>
                              <div className="muted">
                                {roleCreateAgentInputs.items.length
                                  ? `共 ${roleCreateAgentInputs.items.length} 项`
                                  : "—"}
                              </div>
                            </div>

                            <div
                              className="row"
                              style={{ marginTop: 10, gap: 10, fontSize: 12, fontWeight: 700 }}
                            >
                              <div style={{ flex: 1.3, minWidth: 0 }}>名称</div>
                              <div style={{ width: 120 }}>apply</div>
                              <div style={{ width: 110 }}>root</div>
                              <div style={{ flex: 2, minWidth: 0 }}>target.path</div>
                              <div style={{ width: 120 }}>source</div>
                            </div>

                            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                              {roleCreateAgentInputs.items.length ? (
                                roleCreateAgentInputs.items.map((it) => {
                                  const selected = it.id === createAgentInputsSelectedId;
                                  const srcType = (it.source as any)?.type ?? "—";
                                  const name =
                                    typeof (it as any)?.name === "string"
                                      ? String((it as any).name).trim()
                                      : "";
                                  return (
                                    <div
                                      key={it.id}
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => setCreateAgentInputsSelectedId(it.id)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          setCreateAgentInputsSelectedId(it.id);
                                        }
                                      }}
                                      style={{
                                        border: "1px solid var(--card-border)",
                                        borderColor: selected
                                          ? "var(--primary)"
                                          : "var(--card-border)",
                                        borderRadius: 12,
                                        padding: 10,
                                        cursor: "pointer",
                                        background: "var(--list-bg)",
                                      }}
                                    >
                                      <div
                                        className="row"
                                        style={{ gap: 10, alignItems: "baseline" }}
                                      >
                                        <div
                                          style={{
                                            flex: 1.3,
                                            minWidth: 0,
                                            fontSize: 12,
                                            fontWeight: 800,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                          }}
                                          title={name || ""}
                                        >
                                          {name || "—"}
                                        </div>
                                        <div style={{ width: 120, fontSize: 12 }}>{it.apply}</div>
                                        <div style={{ width: 110, fontSize: 12 }}>
                                          {it.target?.root ?? "—"}
                                        </div>
                                        <div
                                          style={{
                                            flex: 2,
                                            minWidth: 0,
                                            fontSize: 12,
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                          }}
                                          title={it.target?.path ?? ""}
                                        >
                                          {it.target?.path ?? ""}
                                        </div>
                                        <div style={{ width: 120, fontSize: 12 }}>{srcType}</div>
                                      </div>
                                    </div>
                                  );
                                })
                              ) : (
                                <div className="muted">暂无 items，点击“新增”创建。</div>
                              )}
                            </div>
                          </div>

                          <div
                            className="rounded-lg border bg-card p-4"
                            style={{ flex: 1, minWidth: 380 }}
                          >
                            <div
                              className="row spaceBetween"
                              style={{ gap: 10, alignItems: "baseline" }}
                            >
                              <div style={{ fontWeight: 800 }}>详情</div>
                              <div className="muted">
                                {(() => {
                                  const idx = roleCreateAgentInputs.items.findIndex(
                                    (x) => x.id === createAgentInputsSelectedId,
                                  );
                                  const it = idx >= 0 ? roleCreateAgentInputs.items[idx] : null;
                                  return it ? `编辑：${it.id}` : "—";
                                })()}
                              </div>
                            </div>

                            {(() => {
                              const idx = roleCreateAgentInputs.items.findIndex(
                                (x) => x.id === createAgentInputsSelectedId,
                              );
                              const it = idx >= 0 ? roleCreateAgentInputs.items[idx] : null;
                              if (!it)
                                return (
                                  <div className="muted" style={{ marginTop: 10 }}>
                                    选择左侧某个 item 以编辑。
                                  </div>
                                );

                              const update = (next: AgentInputItem) => {
                                setRoleCreateAgentInputs((prev) => {
                                  if (!prev) return prev;
                                  const items = [...prev.items];
                                  items[idx] = next;
                                  return { ...prev, items };
                                });
                              };

                              return (
                                <div className="stack" style={{ gap: 12, marginTop: 10 }}>
                                  <label className="label">
                                    名称（可选）
                                    <Input
                                      value={(it as any).name ?? ""}
                                      onChange={(e) => {
                                        const v = e.target.value.trim();
                                        update({
                                          ...it,
                                          ...(v ? { name: v } : { name: undefined }),
                                        });
                                      }}
                                    />
                                  </label>
                                  <label className="label">
                                    target.root
                                    <Select
                                      value={
                                        (it.target?.root ?? "USER_HOME") as AgentInputsTargetRoot
                                      }
                                      onValueChange={(v) =>
                                        update({
                                          ...it,
                                          target: {
                                            ...(it.target as any),
                                            root: v as AgentInputsTargetRoot,
                                          },
                                        })
                                      }
                                      disabled={it.apply === "bindMount"}
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="选择 root" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="WORKSPACE">WORKSPACE</SelectItem>
                                        <SelectItem value="USER_HOME">USER_HOME</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </label>
                                  <label className="label">
                                    target.path
                                    <Input
                                      value={it.target?.path ?? ""}
                                      onChange={(e) =>
                                        update({
                                          ...it,
                                          target: { ...(it.target as any), path: e.target.value },
                                        })
                                      }
                                      disabled={it.apply === "bindMount"}
                                    />
                                  </label>
                                  {it.source.type === "inlineText" ? (
                                    <label className="label">
                                      source.inlineText.text
                                      <Textarea
                                        aria-label="source.inlineText.text"
                                        value={it.source.text ?? ""}
                                        onChange={(e) =>
                                          update({
                                            ...it,
                                            source: {
                                              ...(it.source as any),
                                              type: "inlineText",
                                              text: e.target.value,
                                            },
                                          })
                                        }
                                        rows={10}
                                      />
                                    </label>
                                  ) : null}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </details>

                <div className="muted" style={{ marginTop: 10 }}>
                  复制为新角色：仅需填写新的 <code>Role Key</code>，其余字段将沿用；已加载的 Skills
                  / Agent 文件配置也会一并复制。
                  <br />
                  initScript 默认在 workspace 执行；建议把持久内容写到{" "}
                  <code>$HOME/.tuixiu/projects/&lt;projectId&gt;</code>。
                  <br />
                  envText 仅在携带 admin 凭证时返回；请避免在其中存放不必要的敏感信息。
                </div>
              </form>
                */}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
