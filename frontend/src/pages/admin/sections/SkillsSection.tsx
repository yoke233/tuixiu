import { useCallback, useEffect, useMemo, useState } from "react";

import { getSkill, listSkillVersions, searchSkills, type SkillDetail, type SkillSearchItem, type SkillVersion } from "../../../api/skills";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [items, setItems] = useState<SkillSearchItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const [selectedSkillId, setSelectedSkillId] = useState<string>("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const normalizedQ = q.trim();
  const normalizedTags = tags.trim();

  const doSearch = useCallback(async () => {
    setLocalError(null);
    setError(null);
    if (!requireAdmin()) return;
    setLoading(true);
    onLoadingChange?.(true);
    try {
      const res = await searchSkills({ provider: "registry", q: normalizedQ || undefined, tags: normalizedTags || undefined, limit: 50 });
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  }, [normalizedQ, normalizedTags, onLoadingChange, requireAdmin, setError]);

  useEffect(() => {
    if (!active) return;
    void doSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reloadToken]);

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

  return (
    <section className="card" hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>Skills</h2>
          <div className="muted">一期：仅支持 registry provider（平台已入库技能）。后续可扩展外部搜索与导入。</div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Button type="button" variant="secondary" size="sm" onClick={() => void doSearch()} disabled={loading}>
            刷新
          </Button>
        </div>
      </div>

      <form onSubmit={onSubmit} className="stack" style={{ marginTop: 12 }}>
        <div className="row">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="关键词（name/description/tag）" aria-label="关键词" />
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="tags（逗号分隔，可选）" aria-label="tags" />
          <Button type="submit" disabled={loading}>
            搜索
          </Button>
        </div>
      </form>

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
                  return (
                    <li key={it.skillId} className={`listItem adminListItem ${selected ? "selected" : ""}`}>
                      <button type="button" className="adminListItemButton" onClick={() => void openDetail(it.skillId)}>
                        <div className="row spaceBetween" style={{ gap: 10, alignItems: "center" }}>
                          <div className="cellStack" style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800 }}>{it.name}</div>
                            <div className="cellSub">
                              <code>{it.skillId}</code>
                              {it.latestVersion ? ` · ${new Date(it.latestVersion.importedAt).toLocaleString()}` : " · 无版本"}
                            </div>
                          </div>
                          <div className="row" style={{ gap: 8 }}>
                            {it.latestVersion ? <Badge variant="secondary">最新</Badge> : <Badge variant="outline">无版本</Badge>}
                          </div>
                        </div>
                        {it.description ? <div className="muted" style={{ marginTop: 6 }}>{it.description}</div> : null}
                        {tagsPreview.length ? (
                          <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
                            {tagsPreview.map((t) => (
                              <Badge key={t} variant="outline">
                                {t}
                              </Badge>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="muted">
                暂无匹配技能。若这是首次使用，请先导入/入库 skills（后续迭代提供上传/同步能力）。
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
            <div className="muted" style={{ marginTop: 12 }}>
              请选择一个技能查看详情
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
