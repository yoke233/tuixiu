import { useState } from "react";

import { type RoleSkillItem } from "@/api/roleSkills";
import { type SkillSearchItem, type SkillVersion } from "@/api/skills";
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

export type RoleSkillsCardProps = {
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
};

export function RoleSkillsCard(props: RoleSkillsCardProps) {
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
            <Button
                type="button"
                variant="ghost"
                className="row spaceBetween h-auto w-full justify-between px-0 py-0"
                style={{
                    alignItems: "baseline",
                    flexWrap: "wrap",
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
            </Button>

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
