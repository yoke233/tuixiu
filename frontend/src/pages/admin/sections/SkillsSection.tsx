import { useCallback, useEffect, useMemo, useState } from "react";

import { checkSkillUpdates, getSkill, importSkill, listSkillVersions, searchSkills, updateSkills, type SkillCheckUpdatesResponse, type SkillDetail, type SkillSearchItem, type SkillVersion } from "@/api/skills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function formatInstalls(installs: number | null | undefined): string | null {
  if (typeof installs !== "number" || !Number.isFinite(installs)) return null;
  const v = Math.max(0, Math.floor(installs));
  try {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
  } catch {
    return String(v);
  }
}

type Props = {
  active: boolean;
  reloadToken: number;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function SkillsSection(props: Props) {
  const { active, reloadToken, requireAdmin, setError, onLoadingChange } = props;

  const [q, setQ] = useState("");
  const [tags, setTags] = useState("");
  const [provider, setProvider] = useState<"registry" | "skills.sh">("registry");
  const [items, setItems] = useState<SkillSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [importingSourceKey, setImportingSourceKey] = useState<string>("");
  const [importResult, setImportResult] = useState<string | null>(null);

  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatesResult, setUpdatesResult] = useState<SkillCheckUpdatesResponse | null>(null);
  const [updating, setUpdating] = useState(false);
  const [publishLatest, setPublishLatest] = useState(false);

  const normalizedQ = q.trim();
  const normalizedTags = tags.trim();

  const doSearch = useCallback(async () => {
    setLocalError(null);
    setError(null);
    setImportResult(null);
    if (!requireAdmin()) return;
    setLoading(true);
    onLoadingChange?.(true);
    try {
      const res = await searchSkills({
        provider,
        q: normalizedQ || undefined,
        tags: provider === "registry" ? (normalizedTags || undefined) : undefined,
        limit: 50,
      });
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  }, [normalizedQ, normalizedTags, onLoadingChange, provider, requireAdmin, setError]);

  useEffect(() => {
    if (!active) return;
    void doSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadToken, provider]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      await doSearch();
    },
    [doSearch],
  );

  const selectedItem = useMemo(
    () => (selectedSkillId ? items.find((x) => x.skillId === selectedSkillId) ?? null : null),
    [items, selectedSkillId],
  );

  const openDetail = useCallback(
    async (skillId: string) => {
      setSelectedSkillId(skillId);
      setDetail(null);
      setVersions([]);
      setLocalError(null);
      setError(null);
      if (!requireAdmin()) return;

      setDetailLoading(true);
      try {
        const [s, vs] = await Promise.all([getSkill(skillId), listSkillVersions(skillId)]);
        setDetail(s);
        setVersions(vs);
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : String(e));
      } finally {
        setDetailLoading(false);
      }
    },
    [requireAdmin, setError],
  );

  const onImport = useCallback(
    async (it: SkillSearchItem) => {
      if (!requireAdmin()) return;
      const sourceKey = it.sourceKey?.trim() ?? "";
      if (!sourceKey) return;

      setImportResult(null);
      setImportingSourceKey(sourceKey);
      try {
        const res = await importSkill({
          provider: "skills.sh",
          sourceRef: sourceKey,
          mode: it.installed ? "new-version" : "new-skill",
        });
        const skillId = res.skill?.id ?? "";
        await doSearch();
        setImportResult(`导入成功：${res.meta?.name ?? sourceKey}`);
        if (skillId) await openDetail(skillId);
      } catch (e) {
        setImportResult(`导入失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setImportingSourceKey("");
      }
    },
    [doSearch, openDetail, requireAdmin],
  );

  const onCheckUpdates = useCallback(async () => {
    if (!requireAdmin()) return;
    setUpdatesLoading(true);
    setUpdatesResult(null);
    setError(null);
    try {
      const res = await checkSkillUpdates({ sourceType: "skills.sh" });
      setUpdatesResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdatesLoading(false);
    }
  }, [requireAdmin, setError]);

  const onUpdateAll = useCallback(async () => {
    if (!requireAdmin()) return;
    const ids = (updatesResult?.items ?? []).filter((x) => x.hasUpdate).map((x) => x.skillId);
    if (!ids.length) return;
    if (!window.confirm(`确认更新 ${ids.length} 个 skills？\n\n默认仅导入新版本，不会自动发布 latest。`)) return;

    setUpdating(true);
    setError(null);
    try {
      await updateSkills({ skillIds: ids, publishLatest });
      await onCheckUpdates();
      await doSearch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpdating(false);
    }
  }, [doSearch, onCheckUpdates, publishLatest, requireAdmin, setError, updatesResult?.items]);

  return (
    <section className="card" hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>Skills</h2>
          <div className="muted">支持 registry（已入库）与 skills.sh（外部搜索+导入）。</div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Select value={provider} onValueChange={(v) => setProvider(v as any)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="registry">registry</SelectItem>
              <SelectItem value="skills.sh">skills.sh</SelectItem>
            </SelectContent>
          </Select>
          <Button type="button" variant="secondary" size="sm" onClick={() => void doSearch()} disabled={loading}>
            刷新
          </Button>
        </div>
      </div>

      <form onSubmit={onSubmit} className="stack" style={{ marginTop: 12 }}>
        <div className="row">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={provider === "skills.sh" ? "关键词（skills.sh）" : "关键词（name/description/tag）"} aria-label="关键词" />
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder={provider === "registry" ? "tags（逗号分隔，可选）" : "tags（仅 registry）"}
            aria-label="tags"
            disabled={provider !== "registry"}
          />
          <Button type="submit" disabled={loading}>
            搜索
          </Button>
        </div>
      </form>

      {provider === "registry" ? (
        <div className="row gap" style={{ marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <Button type="button" variant="secondary" size="sm" onClick={() => void onCheckUpdates()} disabled={updatesLoading}>
            {updatesLoading ? "检查更新中…" : "检查 skills.sh 更新"}
          </Button>
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={publishLatest} onChange={(e) => setPublishLatest(e.target.checked)} />
            <span className="muted">更新后发布 latest（默认关闭）</span>
          </label>
          <Button
            type="button"
            size="sm"
            onClick={() => void onUpdateAll()}
            disabled={updating || !(updatesResult?.items ?? []).some((x) => x.hasUpdate)}
          >
            {updating ? "更新中…" : "批量更新"}
          </Button>
          {updatesResult ? (
            <span className="muted">
              可更新：{updatesResult.items.filter((x) => x.hasUpdate).length} / {updatesResult.items.length}
            </span>
          ) : null}
        </div>
      ) : null}

      {importResult ? (
        <div className="muted" style={{ marginTop: 12 }}>
          {importResult}
        </div>
      ) : null}

      {localError ? (
        <div role="alert" className="alert" style={{ marginTop: 12 }}>
          {localError}
        </div>
      ) : null}

      {loading ? (
        <div className="muted" style={{ marginTop: 12 }}>
          加载中…
        </div>
      ) : null}

      <div className="adminSplit" style={{ marginTop: 12 }}>
        <div className="adminSplitList rounded-lg border bg-card p-4">
          <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800 }}>技能列表</div>
            <div className="muted">{items.length ? `显示 ${items.length}` : "—"}</div>
          </div>

          <div className="tableScroll" style={{ marginTop: 12, maxHeight: 520 }}>
            {items.length ? (
              <ul className="list" style={{ marginTop: 0 }}>
                {items.map((it) => {
                  const selected = selectedSkillId === it.skillId;
                  const tagsPreview = Array.isArray(it.tags) ? it.tags.slice(0, 6) : [];
                  const isExternal = provider === "skills.sh";
                  const canOpen = it.installed && /^[0-9a-f-]{36}$/i.test(it.skillId);
                  const installsLabel = isExternal ? formatInstalls(it.installs) : null;
                  const selectItem = () => {
                    if (canOpen) {
                      void openDetail(it.skillId);
                      return;
                    }
                    setSelectedSkillId(it.skillId);
                    setDetail(null);
                    setVersions([]);
                    setDetailLoading(false);
                  };
                  return (
                    <li key={it.skillId} className={`listItem adminListItem ${selected ? "selected" : ""}`}>
                      <div
                        className="adminListItemButton"
                        role="button"
                        tabIndex={0}
                        onClick={selectItem}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          selectItem();
                        }}
                      >
                        <div className="row spaceBetween" style={{ gap: 10, alignItems: "center" }}>
                          <div className="cellStack" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800 }}>{it.name}</div>
                            <div className="cellSub">
                              <code>{isExternal ? (it.sourceKey ?? it.skillId) : it.skillId}</code>
                              {it.latestVersion ? ` · ${new Date(it.latestVersion.importedAt).toLocaleString()}` : " · 未发布 latest"}
                            </div>
                          </div>
                          <div className="row" style={{ gap: 8 }}>
                            {isExternal ? (
                              it.installed ? (
                                <Badge variant="secondary">已导入</Badge>
                              ) : (
                                <Badge variant="outline">未导入</Badge>
                              )
                            ) : it.latestVersion ? (
                              <Badge variant="secondary">latest</Badge>
                            ) : (
                              <Badge variant="outline">未发布</Badge>
                            )}
                            {installsLabel ? (
                              <Badge variant="outline" title={`skills.sh 下载量：${it.installs ?? ""}`}>
                                下载 {installsLabel}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        {it.description ? <div className="muted" style={{ marginTop: 6 }}>{it.description}</div> : null}
                        {isExternal ? (
                          <div className="row gap" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                            {it.sourceRef ? (
                              <a href={it.sourceRef} target="_blank" rel="noreferrer" className="muted">
                                skills.sh
                              </a>
                            ) : null}
                            {it.githubRepoUrl ? (
                              <a href={it.githubRepoUrl} target="_blank" rel="noreferrer" className="muted">
                                GitHub
                              </a>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void onImport(it);
                              }}
                              disabled={importingSourceKey === (it.sourceKey ?? "") || !it.sourceKey}
                            >
                              {importingSourceKey === (it.sourceKey ?? "")
                                ? "导入中…"
                                : it.installed
                                  ? "导入新版本"
                                  : "导入"}
                            </Button>
                          </div>
                        ) : null}
                        {tagsPreview.length ? (
                          <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
                            {tagsPreview.map((t) => (
                              <Badge key={t} variant="outline">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="muted">
                暂无匹配技能。
              </div>
            )}
          </div>
        </div>

        <div className="adminSplitDetail rounded-lg border bg-card p-4">
          <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800 }}>技能详情</div>
            {detailLoading ? <div className="muted">加载中…</div> : null}
          </div>

          {!selectedItem ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="muted">右侧用于查看详情 / 导入 / 版本列表。</div>
              {provider === "skills.sh" ? (
                <div className="muted">
                  先在左侧输入关键词并搜索，然后点击某条结果；未导入的技能会在这里提供「导入」操作。
                </div>
              ) : (
                <div className="muted">从左侧选择已入库技能，可查看版本列表，并可检查/批量更新。</div>
              )}
            </div>
          ) : provider === "skills.sh" && !selectedItem.installed ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kvGrid">
                <div className="kvItem">
                  <div className="muted">Name</div>
                  <div style={{ fontWeight: 800 }}>{selectedItem.name}</div>
                </div>
                <div className="kvItem">
                  <div className="muted">Source</div>
                  <code>{selectedItem.sourceKey ?? selectedItem.skillId}</code>
                </div>
                {typeof selectedItem.installs === "number" ? (
                  <div className="kvItem">
                    <div className="muted">Downloads</div>
                    <code>{new Intl.NumberFormat().format(selectedItem.installs)}</code>
                  </div>
                ) : null}
              </div>

              <div className="row gap" style={{ flexWrap: "wrap", alignItems: "center" }}>
                {selectedItem.sourceRef ? (
                  <a href={selectedItem.sourceRef} target="_blank" rel="noreferrer" className="muted">
                    skills.sh
                  </a>
                ) : null}
                {selectedItem.githubRepoUrl ? (
                  <a href={selectedItem.githubRepoUrl} target="_blank" rel="noreferrer" className="muted">
                    GitHub
                  </a>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void onImport(selectedItem)}
                  disabled={importingSourceKey === (selectedItem.sourceKey ?? "") || !selectedItem.sourceKey}
                >
                  {importingSourceKey === (selectedItem.sourceKey ?? "") ? "导入中…" : "导入"}
                </Button>
              </div>

              <div className="muted">导入后可查看版本列表，并可在角色模板中启用。</div>
            </div>
          ) : detail ? (
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="kvGrid">
                <div className="kvItem">
                  <div className="muted">Name</div>
                  <div style={{ fontWeight: 800 }}>{detail.name}</div>
                </div>
                <div className="kvItem">
                  <div className="muted">Skill ID</div>
                  <code>{detail.id}</code>
                </div>
                <div className="kvItem">
                  <div className="muted">Updated</div>
                  <code>{new Date(detail.updatedAt).toLocaleString()}</code>
                </div>
                {provider === "skills.sh" && typeof selectedItem.installs === "number" ? (
                  <div className="kvItem">
                    <div className="muted">Downloads</div>
                    <code>{new Intl.NumberFormat().format(selectedItem.installs)}</code>
                  </div>
                ) : null}
              </div>

              <div>
                <div className="muted">描述</div>
                <div>{detail.description || <span className="muted">（无）</span>}</div>
              </div>

              <div>
                <div className="muted">版本</div>
                {versions.length ? (
                  <ul className="list" style={{ marginTop: 10 }}>
                    {versions.map((v) => (
                      <li key={v.id} className="listItem">
                        <div className="row spaceBetween" style={{ gap: 10 }}>
                          <code>{v.id}</code>
                          <span className="muted">{new Date(v.importedAt).toLocaleString()}</span>
                        </div>
                        <div className="muted" style={{ marginTop: 6 }}>
                          <code>{v.contentHash}</code>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="muted" style={{ marginTop: 8 }}>
                    （暂无版本）
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="muted" style={{ marginTop: 12 }}>
              {detailLoading ? "加载中…" : "详情不可用"}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
