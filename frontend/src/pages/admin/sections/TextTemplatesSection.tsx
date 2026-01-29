import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getProjectTextTemplates,
  listPlatformTextTemplates,
  patchPlatformTextTemplates,
  patchProjectTextTemplates,
  type TextTemplateMap,
} from "../../../api/textTemplates";
import type { Project } from "../../../types";

function getAllKeys(...maps: Array<TextTemplateMap | null | undefined>): string[] {
  const set = new Set<string>();
  for (const map of maps) {
    if (!map) continue;
    for (const key of Object.keys(map)) set.add(key);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function toPatchValue(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return normalized ? normalized : null;
}

type Props = {
  active: boolean;
  effectiveProjectId: string;
  effectiveProject: Project | null;
  reloadToken: number;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onLoadingChange?: (loading: boolean) => void;
};

export function TextTemplatesSection(props: Props) {
  const { active, effectiveProjectId, effectiveProject, reloadToken, requireAdmin, setError, onLoadingChange } = props;

  const [platformTemplates, setPlatformTemplates] = useState<TextTemplateMap>({});
  const [projectOverrides, setProjectOverrides] = useState<TextTemplateMap>({});
  const [loading, setLoading] = useState(false);
  const [savingPlatform, setSavingPlatform] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);

  const [selectedKey, setSelectedKey] = useState("");
  const [platformDraft, setPlatformDraft] = useState("");
  const [overrideDraft, setOverrideDraft] = useState("");

  const allKeys = useMemo(
    () => getAllKeys(platformTemplates, effectiveProjectId ? projectOverrides : null, selectedKey.trim() ? { [selectedKey.trim()]: "" } : null),
    [effectiveProjectId, platformTemplates, projectOverrides, selectedKey],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (effectiveProjectId) {
        const data = await getProjectTextTemplates(effectiveProjectId);
        setPlatformTemplates(data.platform);
        setProjectOverrides(data.overrides);
      } else {
        const data = await listPlatformTextTemplates();
        setPlatformTemplates(data);
        setProjectOverrides({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [effectiveProjectId, setError]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh, reloadToken]);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    if (!active) return;
    if (selectedKey.trim()) return;
    const first = allKeys[0] ?? "";
    if (first) setSelectedKey(first);
  }, [active, allKeys, selectedKey]);

  useEffect(() => {
    if (!active) return;
    const key = selectedKey.trim();
    if (!key) {
      setPlatformDraft("");
      setOverrideDraft("");
      return;
    }
    setPlatformDraft(platformTemplates[key] ?? "");
    setOverrideDraft(effectiveProjectId ? projectOverrides[key] ?? "" : "");
  }, [active, effectiveProjectId, platformTemplates, projectOverrides, selectedKey]);

  const preview = useMemo(() => {
    const key = selectedKey.trim();
    if (!key) return { source: "missing" as const, text: "" };
    if (effectiveProjectId) {
      const override = toPatchValue(overrideDraft);
      if (override) return { source: "project" as const, text: override };
    }
    const platform = toPatchValue(platformDraft);
    if (platform) return { source: "platform" as const, text: platform };
    return { source: "missing" as const, text: "" };
  }, [effectiveProjectId, overrideDraft, platformDraft, selectedKey]);

  const onSavePlatform = useCallback(async () => {
    const key = selectedKey.trim();
    if (!key) {
      setError("请先输入模板 key");
      return;
    }
    if (!requireAdmin()) return;

    setSavingPlatform(true);
    setError(null);
    try {
      const next = await patchPlatformTextTemplates({ [key]: toPatchValue(platformDraft) });
      setPlatformTemplates(next);
      if (effectiveProjectId) {
        const data = await getProjectTextTemplates(effectiveProjectId);
        setPlatformTemplates(data.platform);
        setProjectOverrides(data.overrides);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPlatform(false);
    }
  }, [effectiveProjectId, platformDraft, requireAdmin, selectedKey, setError]);

  const onSaveOverride = useCallback(async () => {
    const key = selectedKey.trim();
    if (!key) {
      setError("请先输入模板 key");
      return;
    }
    if (!effectiveProjectId) {
      setError("请先创建/选择 Project");
      return;
    }
    if (!requireAdmin()) return;

    setSavingOverride(true);
    setError(null);
    try {
      const data = await patchProjectTextTemplates(effectiveProjectId, { [key]: toPatchValue(overrideDraft) });
      setPlatformTemplates(data.platform);
      setProjectOverrides(data.overrides);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingOverride(false);
    }
  }, [effectiveProjectId, overrideDraft, requireAdmin, selectedKey, setError]);

  const platformCount = Object.keys(platformTemplates).length;
  const overrideCount = Object.keys(projectOverrides).length;

  const keyExistsInPlatform = !!(selectedKey.trim() && Object.prototype.hasOwnProperty.call(platformTemplates, selectedKey.trim()));
  const keyExistsInOverride = !!(selectedKey.trim() && Object.prototype.hasOwnProperty.call(projectOverrides, selectedKey.trim()));

  const busy = loading || savingPlatform || savingOverride;

  return (
    <section className="card" style={{ marginBottom: 16 }} hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>文本模板</h2>
          <div className="muted">
            平台模板 / Project 覆盖（Handlebars）。平台：{platformCount}
            {effectiveProjectId ? ` · 覆盖：${overrideCount}` : ""}
          </div>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="buttonSecondary" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button type="button" onClick={() => void onSavePlatform()} disabled={!selectedKey.trim() || busy}>
            {savingPlatform ? "保存中…" : "保存平台"}
          </button>
          <button
            type="button"
            onClick={() => void onSaveOverride()}
            disabled={!selectedKey.trim() || !effectiveProjectId || busy}
          >
            {savingOverride ? "保存中…" : "保存覆盖"}
          </button>
        </div>
      </div>

      <div className="muted" style={{ marginTop: 10 }}>
        {effectiveProject ? (
          <>
            当前 Project：<code>{effectiveProject.name}</code>（id: <code>{effectiveProject.id}</code>）
          </>
        ) : (
          "未选择 Project（仍可编辑平台模板）。"
        )}
      </div>

      <div className="row gap" style={{ alignItems: "flex-end", marginTop: 12 }}>
        <label className="label" style={{ margin: 0, flex: "2 1 360px", minWidth: 260 }}>
          模板 key
          <input
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            placeholder="输入或选择 key（支持新增）"
            list="textTemplateKeys"
          />
          <datalist id="textTemplateKeys">
            {allKeys.map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
        </label>

        <div className="muted" style={{ paddingBottom: 6 }}>
          {selectedKey.trim() ? (
            <>
              {keyExistsInPlatform ? "平台已存在" : "平台不存在"}
              {effectiveProjectId ? (keyExistsInOverride ? " · 覆盖已存在" : " · 覆盖不存在") : ""}
              {" · "}
              生效来源：<code>{preview.source}</code>
            </>
          ) : (
            "先输入一个 key"
          )}
        </div>
      </div>

      <div className="grid2" style={{ marginTop: 12, marginBottom: 0 }}>
        <div>
          <h3 style={{ marginTop: 0, marginBottom: 6 }}>平台模板</h3>
          <div className="muted" style={{ marginBottom: 6 }}>
            留空保存 = 删除该平台模板（key 会消失）。
          </div>
          <textarea
            value={platformDraft}
            onChange={(e) => setPlatformDraft(e.target.value)}
            rows={10}
            className="inputMono"
            style={{ width: "100%" }}
            placeholder={selectedKey.trim() ? "例如：Hello, {{user.name}}!" : "请先输入 key"}
            readOnly={!selectedKey.trim()}
          />
        </div>

        <div>
          <h3 style={{ marginTop: 0, marginBottom: 6 }}>Project 覆盖</h3>
          {effectiveProjectId ? (
            <>
              <div className="muted" style={{ marginBottom: 6 }}>
                留空保存 = 清除覆盖（回退到平台模板）。
              </div>
              <textarea
                value={overrideDraft}
                onChange={(e) => setOverrideDraft(e.target.value)}
                rows={10}
                className="inputMono"
                style={{ width: "100%" }}
                placeholder={selectedKey.trim() ? "不填则使用平台模板" : "请先输入 key"}
                readOnly={!selectedKey.trim()}
              />
              <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => setOverrideDraft(platformDraft)}
                  disabled={!selectedKey.trim() || busy}
                  title="把当前平台模板内容复制到覆盖里，方便再做微调"
                >
                  复制平台到覆盖
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => setOverrideDraft("")}
                  disabled={!selectedKey.trim() || busy}
                  title="清空覆盖（需要再点一次“保存覆盖”才会生效）"
                >
                  清空覆盖
                </button>
              </div>
            </>
          ) : (
            <div className="muted">请先创建/选择 Project（才能编辑覆盖）。</div>
          )}
        </div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary>生效预览</summary>
        <div className="muted" style={{ marginTop: 8 }}>
          source: <code>{preview.source}</code>
        </div>
        <pre className="pre" style={{ marginTop: 8 }}>
          {preview.text ? preview.text : "（空 / missing）"}
        </pre>
      </details>

      <div className="muted" style={{ marginTop: 10 }}>
        后端接口：<code>GET/PATCH /api/text-templates</code>、<code>GET/PATCH /api/projects/:projectId/text-templates</code>。
      </div>
    </section>
  );
}

