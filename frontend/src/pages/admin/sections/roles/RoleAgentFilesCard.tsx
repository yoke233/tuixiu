import { useCallback, useMemo, useState } from "react";

import type { AgentInputItem, AgentInputsApply, AgentInputsTargetRoot } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
    type RoleAgentFilesCardProps,
    replaceTargetPathFileName,
    resolveAgentInputDisplayName,
} from "@/pages/admin/sections/roles/roleAgentFilesHelpers";

export function RoleAgentFilesCard(props: RoleAgentFilesCardProps) {
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
                    {statusHint ? <div className="muted">{statusHint}</div> : null}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                    {hasItems ? `${manifest.items.length} 项` : "未配置"} · {effectiveOpen ? "点击收起" : "点击展开"}
                </div>
            </Button>

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
                                <div className="muted">{manifest.items.length ? `共 ${manifest.items.length} 项` : "—"}</div>
                            </div>

                            <div className="row" style={{ marginTop: 10, gap: 10, fontSize: 12, fontWeight: 700 }}>
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
                                        const name = resolveAgentInputDisplayName(it);
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
                                <div className="muted">
                                    {selectedItem ? `编辑：${resolveAgentInputDisplayName(selectedItem) || selectedItem.id}` : "—"}
                                </div>
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
                                                        updateSelected((prev) => {
                                                            const nextName = String(f.name ?? "").trim();
                                                            const nextPath = replaceTargetPathFileName(
                                                                String(prev.target?.path ?? ""),
                                                                nextName,
                                                            );
                                                            return {
                                                                ...prev,
                                                                ...(nextName ? { name: nextName } : {}),
                                                                source: { ...(prev.source as any), type: "inlineText", text },
                                                                target: { ...(prev.target as any), path: nextPath },
                                                            };
                                                        });
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
                                                            updateSelected((prev) => {
                                                                const nextName = String(f.name ?? "").trim();
                                                                const nextPath = replaceTargetPathFileName(
                                                                    String(prev.target?.path ?? ""),
                                                                    nextName,
                                                                );
                                                                return {
                                                                    ...prev,
                                                                    ...(nextName ? { name: nextName } : {}),
                                                                    source: { ...(prev.source as any), type: "inlineText", text },
                                                                    target: { ...(prev.target as any), path: nextPath },
                                                                };
                                                            });
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
