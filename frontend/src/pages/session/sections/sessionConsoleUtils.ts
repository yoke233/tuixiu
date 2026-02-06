import { buildConsoleItems } from "@/components/runConsole/buildConsoleItems";
import { findLatestSandboxInstanceStatus, parseSandboxInstanceStatusText } from "@/utils/sandboxStatus";
import type { Event } from "@/types";

type ConfigOption = {
    id: string;
    name?: string;
    type?: string;
    category?: string;
    description?: string;
    currentValue?: unknown;
    options?: Array<{
        name?: string;
        value?: unknown;
        description?: string;
    }>;
};

export function buildSandboxHint(events: Event[]) {
    const sandboxStatus = findLatestSandboxInstanceStatus(events);
    if (!sandboxStatus) {
        return {
            sandboxStatus: null,
            sandboxHint: null,
            sandboxTitle: "",
        };
    }

    const status = sandboxStatus.status;
    const sandboxHint =
        status === "running"
            ? { label: "容器已启动（工具可用）", tone: "ok" as const }
            : status === "creating" || status === "missing"
                ? { label: "容器启动中…", tone: "pending" as const }
                : status === "stopped"
                    ? { label: "容器已停止", tone: "muted" as const }
                    : status === "error"
                        ? { label: "容器异常", tone: "error" as const }
                        : { label: `容器状态：${status}`, tone: "muted" as const };

    const sandboxTitle = [
        sandboxStatus.instanceName ? `实例: ${sandboxStatus.instanceName}` : "",
        sandboxStatus.runtime ? `运行时: ${sandboxStatus.runtime}` : "",
        sandboxStatus.provider ? `provider: ${sandboxStatus.provider}` : "",
        sandboxStatus.lastSeenAt ? `last_seen_at: ${sandboxStatus.lastSeenAt}` : "",
        sandboxStatus.lastError ? `last_error: ${sandboxStatus.lastError}` : "",
    ]
        .filter(Boolean)
        .join(" | ");

    return { sandboxStatus, sandboxHint, sandboxTitle };
}

export function computeConsoleHiddenStatusCount(events: Event[], liveEventIds: Set<string>) {
    const items = buildConsoleItems(events, { liveEventIds });
    const baseFiltered = items.filter((item) => {
        if (item.role !== "system") return true;
        if (item.isStatus) return false;
        if (item.detailsTitle && item.detailsTitle.startsWith("可用命令")) return false;
        if (!item.text) return true;
        return !parseSandboxInstanceStatusText(item.text);
    });

    return items.length - baseFiltered.length;
}

export function extractConfigOptions(events: Event[], run: unknown): ConfigOption[] {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const payload = (events[i] as any)?.payload;
        const update = payload?.update;
        if (payload?.type !== "session_update") continue;
        if (update?.sessionUpdate !== "config_option_update") continue;
        return Array.isArray(update?.configOptions) ? (update.configOptions as ConfigOption[]) : [];
    }

    const meta = (run as any)?.metadata;
    const state =
        meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as any).acpSessionState : null;
    const fromMeta = state && typeof state === "object" ? (state as any).configOptions : null;
    return Array.isArray(fromMeta) ? (fromMeta as ConfigOption[]) : [];
}

export function toDisplayConfigOptions(options: ConfigOption[]) {
    const selectable = options.filter((opt) => {
        const type = typeof opt?.type === "string" ? opt.type : "";
        if (type && type !== "select") return false;
        return Array.isArray(opt?.options) && opt.options.length > 0;
    });

    return selectable.slice(0, 3);
}

export function extractAvailableCommands(events: Event[]) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const payload = (events[i] as any)?.payload;
        const update = payload?.update;
        if (payload?.type !== "session_update") continue;
        if (update?.sessionUpdate !== "available_commands_update") continue;
        return Array.isArray(update?.availableCommands) ? update.availableCommands : [];
    }
    return [];
}

export function buildCommandItems(commands: unknown[]) {
    return commands
        .map((cmd: any) => {
            const rawName = typeof cmd?.name === "string" ? cmd.name.trim() : "";
            if (!rawName) return null;
            const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
            const description = typeof cmd?.description === "string" ? cmd.description.trim() : "";
            const hint =
                cmd?.input && typeof cmd.input === "object" && typeof cmd.input.hint === "string"
                    ? String(cmd.input.hint).trim()
                    : "";
            return {
                name,
                display: `/${name}`,
                description,
                hint,
                filterKey: name.toLowerCase(),
            };
        })
        .filter(Boolean) as Array<{
            name: string;
            display: string;
            description: string;
            hint: string;
            filterKey: string;
        }>;
}
