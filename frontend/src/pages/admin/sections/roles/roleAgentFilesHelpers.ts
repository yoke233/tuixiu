import type {
    AgentInputItem,
    AgentInputsApply,
    AgentInputsManifestV1,
    AgentInputsTargetRoot,
} from "@/types";

export function getFileNameFromPath(pathValue: string): string {
    const normalized = String(pathValue ?? "").replaceAll("\\", "/").trim();
    if (!normalized) return "";
    const parts = normalized.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
}

export function resolveAgentInputDisplayName(item: AgentInputItem): string {
    const rawName = typeof (item as any)?.name === "string" ? String((item as any).name).trim() : "";
    if (rawName && !/^code\s*[a-z]$/i.test(rawName)) return rawName;
    return getFileNameFromPath(String(item?.target?.path ?? ""));
}

export function replaceTargetPathFileName(pathValue: string, fileName: string): string {
    const nextFileName = String(fileName ?? "").trim();
    if (!nextFileName) return pathValue;
    const normalized = String(pathValue ?? "").replaceAll("\\", "/").trim();
    if (!normalized) return nextFileName;
    const parts = normalized.split("/");
    if (parts.length <= 1) return nextFileName;
    parts[parts.length - 1] = nextFileName;
    return parts.join("/");
}

export function makeAgentInputId(): string {
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
}

export function normalizeItemForApply(apply: AgentInputsApply, item: AgentInputItem): AgentInputItem {
    if (apply === "writeFile") {
        const src =
            item.source.type === "inlineText"
                ? item.source
                : { type: "inlineText" as const, text: "" };
        return { ...item, apply, source: src };
    }

    if (apply === "downloadExtract") {
        const src = item.source.type === "httpZip" ? item.source : { type: "httpZip" as const, uri: "" };
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
}

export function getAgentsMdInlineText(manifest: AgentInputsManifestV1): { id: string; text: string } | null {
    for (const it of manifest.items) {
        if (!it?.target || it.target.path !== ".codex/AGENTS.md") continue;
        const src = it.source as any;
        if (!src || src.type !== "inlineText") continue;
        return { id: String(it.id ?? ""), text: String(src.text ?? "") };
    }
    return null;
}

export function upsertAgentsMdInlineText(args: {
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

export function cloneAgentInputsManifest(input: unknown): AgentInputsManifestV1 {
    const raw = input as any;
    const itemsRaw =
        raw && typeof raw === "object" && raw.version === 1 && Array.isArray(raw.items) ? raw.items : [];

    return {
        version: 1,
        ...(raw && typeof raw === "object" && raw.envPatch ? { envPatch: raw.envPatch as any } : {}),
        items: itemsRaw.map((it: any) => ({
            id: String(it?.id ?? ""),
            ...(it?.name ? { name: String(it.name ?? "").trim() || undefined } : {}),
            apply: it?.apply as AgentInputsApply,
            ...(it?.access ? { access: it.access } : {}),
            source: it?.source && typeof it.source === "object" ? { ...(it.source as any) } : (it?.source as any),
            target: it?.target && typeof it.target === "object" ? { ...(it.target as any) } : (it?.target as any),
        })),
    };
}

export function createEmptyManifest(): AgentInputsManifestV1 {
    return { version: 1, items: [] };
}

export function createDefaultAgentsMdItem(createId: () => string): AgentInputItem {
    return {
        id: `agents-md-${createId()}`,
        name: "AGENTS.md",
        apply: "writeFile",
        access: "rw",
        source: { type: "inlineText", text: "" },
        target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
    };
}

export type RoleAgentFilesCardSharedProps = {
    agentInputsInlineFileRef: React.RefObject<HTMLInputElement | null>;
    makeAgentInputId: () => string;
    normalizeItemForApply: (apply: AgentInputsApply, item: AgentInputItem) => AgentInputItem;
};

export type RoleAgentFilesCardManifestProps = {
    manifest: AgentInputsManifestV1;
    setManifest: (updater: (prev: AgentInputsManifestV1) => AgentInputsManifestV1) => void;
    selectedId: string;
    onSelectedIdChange: (next: string) => void;
};

export type RoleAgentFilesCardActionProps = {
    title: string;
    subtitle?: string;
    statusHint?: string;
    onSave?: () => void;
    saving?: boolean;
    error?: string | null;
    errorDetails?: unknown | null;
    setError: (msg: string | null) => void;
};

export type RoleAgentFilesCardProps =
    RoleAgentFilesCardManifestProps &
    RoleAgentFilesCardActionProps &
    RoleAgentFilesCardSharedProps;

export type TargetRoot = AgentInputsTargetRoot;
