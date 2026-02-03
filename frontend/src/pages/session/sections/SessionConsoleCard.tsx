import { useEffect, useMemo, useRef, useState } from "react";

import { RunConsole } from "../../../components/RunConsole";
import { apiUrl } from "../../../api/client";
import { buildConsoleItems } from "../../../components/runConsole/buildConsoleItems";
import { parseSandboxInstanceStatusText } from "../../../utils/sandboxStatus";
import { findLatestSandboxInstanceStatus } from "../../../utils/sandboxStatus";
import { findLatestAcpTransportStatus } from "../../../utils/acpTransport";
import type { SessionController } from "../useSessionController";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SessionConsoleCard(props: { model: SessionController }) {
  const {
    auth,
    chatText,
    events,
    liveEventIds,
    issue,
    isAdmin,
    onResolvePermission,
    onSetConfigOption,
    onDropFiles,
    onPause,
    onSend,
    pausing,
    pendingImages,
    permissionRequests,
    removePendingImage,
    resolvedPermissionIds,
    resolvingPermissionId,
    run,
    runId,
    sending,
    sessionId,
    setChatText,
    settingConfigOptionId,
    uploadingImages,
  } = props.model;

  const sandboxStatus = useMemo(() => findLatestSandboxInstanceStatus(events), [events]);
  const sandboxHint = useMemo(() => {
    if (!sandboxStatus) return null;
    const status = sandboxStatus.status;
    if (status === "running") {
      return { label: "容器已启动（工具可用）", tone: "ok" as const };
    }
    if (status === "creating" || status === "missing") {
      return { label: "容器启动中…", tone: "pending" as const };
    }
    if (status === "stopped") {
      return { label: "容器已停止", tone: "muted" as const };
    }
    if (status === "error") {
      return { label: "容器异常", tone: "error" as const };
    }
    return { label: `容器状态：${status}`, tone: "muted" as const };
  }, [sandboxStatus]);

  const sandboxTitle = useMemo(() => {
    if (!sandboxStatus) return "";
    const parts = [
      sandboxStatus.instanceName ? `实例: ${sandboxStatus.instanceName}` : "",
      sandboxStatus.runtime ? `运行时: ${sandboxStatus.runtime}` : "",
      sandboxStatus.provider ? `provider: ${sandboxStatus.provider}` : "",
      sandboxStatus.lastSeenAt ? `last_seen_at: ${sandboxStatus.lastSeenAt}` : "",
      sandboxStatus.lastError ? `last_error: ${sandboxStatus.lastError}` : "",
    ].filter(Boolean);
    return parts.join(" | ");
  }, [sandboxStatus]);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const configMenuRef = useRef<HTMLDivElement | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandMenuForcedOpen, setCommandMenuForcedOpen] = useState(false);
  const [configMenuOpen, setConfigMenuOpen] = useState(false);
  const [showStatusEvents, setShowStatusEvents] = useState(false);

  const consoleStatusSummary = useMemo(() => {
    const items = buildConsoleItems(events, { liveEventIds });
    const baseFiltered = items.filter((item) => {
      if (item.role !== "system") return true;
      // 默认隐藏状态/调试事件（可通过 UI 展开）
      if (item.isStatus) return false;
      // available_commands_update 默认不占屏（需要时可以展开状态事件查看）
      if (item.detailsTitle && item.detailsTitle.startsWith("可用命令")) return false;
      if (!item.text) return true;
      return !parseSandboxInstanceStatusText(item.text);
    });

    return {
      hiddenStatusCount: items.length - baseFiltered.length,
    };
  }, [events, liveEventIds]);

  const transport = useMemo(() => findLatestAcpTransportStatus(events), [events]);
  const sessionOnline = Boolean(sessionId && transport?.connected);
  const sessionBadgeTitle = useMemo(() => {
    if (!transport) return sessionId ? "未收到 transport 事件（状态未知）" : "sessionId 未建立";
    const at = transport.at ? `at=${transport.at}` : "";
    const inst = transport.instanceName ? `instance=${transport.instanceName}` : "";
    const reason = transport.reason ? `reason=${transport.reason}` : "";
    const code = transport.code === null ? "" : `code=${transport.code}`;
    const signal = transport.signal ? `signal=${transport.signal}` : "";
    return [at, inst, reason, code, signal].filter(Boolean).join(" | ");
  }, [transport, sessionId]);

  useEffect(() => {
    if (!configMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!configMenuRef.current) return;
      if (!configMenuRef.current.contains(event.target as Node)) setConfigMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [configMenuOpen]);

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

  const availableConfigOptions = useMemo((): ConfigOption[] => {
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
  }, [events, run]);

  const displayConfigOptions = useMemo(() => {
    // 目前只渲染 select（最常见：mode/model/...）。其余类型先忽略，避免 UI 误导。
    const selectable = availableConfigOptions.filter((opt) => {
      const type = typeof opt?.type === "string" ? opt.type : "";
      if (type && type !== "select") return false;
      return Array.isArray(opt?.options) && opt.options.length > 0;
    });

    // 规范建议按 Agent 优先级展示；通常就是 3 个。
    return selectable.slice(0, 3);
  }, [availableConfigOptions]);

  const availableCommands = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const payload = (events[i] as any)?.payload;
      const update = payload?.update;
      if (payload?.type !== "session_update") continue;
      if (update?.sessionUpdate !== "available_commands_update") continue;
      return Array.isArray(update?.availableCommands) ? update.availableCommands : [];
    }
    return [];
  }, [events]);

  const commandItems = useMemo(() => {
    return availableCommands
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
  }, [availableCommands]);

  const trimmed = chatText.trimStart();
  const hasSlash = trimmed.startsWith("/");
  const query = hasSlash ? trimmed.slice(1).toLowerCase() : "";
  const filteredCommands = useMemo(() => {
    if (!hasSlash) return [];
    if (!query) return commandItems;
    return commandItems.filter((cmd) => cmd.filterKey.includes(query));
  }, [commandItems, hasSlash, query]);

  const showCommandMenu =
    filteredCommands.length > 0 && (hasSlash || commandMenuForcedOpen) && !commandMenuDismissed;

  const handlePickCommand = (name: string) => {
    const next = `/${name} `;
    setChatText(next);
    setCommandMenuDismissed(true);
    setCommandMenuForcedOpen(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showCommandMenu) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCommandIndex((prev) => (prev + 1) % filteredCommands.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCommandIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const picked = filteredCommands[commandIndex];
      if (picked) handlePickCommand(picked.name);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const picked = filteredCommands[commandIndex];
      if (picked) handlePickCommand(picked.name);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setCommandMenuDismissed(true);
      setCommandMenuForcedOpen(false);
    }
  };

  return (
    <section className="card sessionConsoleCard">
      <div
        className="row spaceBetween sessionConsoleHeader"
        style={{ alignItems: "baseline", flexWrap: "wrap" }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="row gap" style={{ alignItems: "center" }}>
            <div style={{ fontWeight: 800 }}>Console</div>
            <span
              className={sessionOnline ? "sessionOnlineDot isOnline" : "sessionOnlineDot isOffline"}
              title={sessionOnline ? `session 在线（可直接访问）${sessionBadgeTitle ? `\n${sessionBadgeTitle}` : ""}` : `session 离线（不可直接访问）${sessionBadgeTitle ? `\n${sessionBadgeTitle}` : ""}`}
              aria-label={sessionOnline ? "session online" : "session offline"}
            />
          </div>
          <div
            className="muted"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {issue?.title ?? "—"}
          </div>
        </div>
        {consoleStatusSummary.hiddenStatusCount > 0 ? (
          <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowStatusEvents((prev) => !prev)}
              title={showStatusEvents ? "隐藏状态事件" : "显示状态事件"}
            >
              {showStatusEvents
                ? `隐藏状态（${consoleStatusSummary.hiddenStatusCount}）`
                : `显示状态（${consoleStatusSummary.hiddenStatusCount}）`}
            </Button>
          </div>
        ) : null}
      </div>

      <div
        className="sessionConsoleBody"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) void onDropFiles(e.dataTransfer.files);
        }}
      >
        <RunConsole
          events={events}
          liveEventIds={liveEventIds}
          showStatusEvents={showStatusEvents}
          permission={{
            isAdmin,
            resolvingRequestId: resolvingPermissionId,
            resolvedRequestIds: resolvedPermissionIds,
            onDecide: (input) => {
              const req =
                permissionRequests.find((x) => x.requestId === input.requestId) ??
                ({
                  requestId: input.requestId,
                  sessionId: input.sessionId,
                  promptId: null,
                  toolCall: undefined,
                  options: [],
                } as any);
              void onResolvePermission(req, { outcome: input.outcome, optionId: input.optionId });
            },
          }}
        />
      </div>

      {pendingImages.length ? (
        <div className="row gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {pendingImages.map((img) => (
            <div key={img.id} style={{ position: "relative" }}>
              <img
                src={apiUrl(img.uri)}
                alt={img.name ?? img.id}
                style={{
                  width: 52,
                  height: 52,
                  objectFit: "cover",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.12)",
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => removePendingImage(img.id)}
                className="absolute -top-2 -right-2 h-6 w-6 rounded-full"
                aria-label="移除图片"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {uploadingImages ? (
        <div className="muted" style={{ marginTop: 6 }}>
          图片上传中…
        </div>
      ) : null}

      <form
        onSubmit={onSend}
        className="consoleInput sessionConsoleInput"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) void onDropFiles(e.dataTransfer.files);
        }}
      >
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="consoleIconButton consoleCommandButton"
          onClick={() => {
            setCommandMenuDismissed(false);
            setCommandMenuForcedOpen(true);
            setCommandIndex(0);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          aria-label="打开命令菜单"
          title="命令"
        >
          /
        </Button>
        <Input
          aria-label="对话输入"
          ref={inputRef}
          value={chatText}
          onChange={(e) => {
            const next = e.target.value;
            setChatText(next);
            if (next.trimStart().startsWith("/")) {
              setCommandMenuDismissed(false);
              setCommandIndex(0);
            }
          }}
          onKeyDown={handleInputKeyDown}
          placeholder={!auth.user ? "登录后可继续对话…" : "像 CLI 一样继续对话…（支持拖拽图片）"}
          disabled={!auth.user || sending}
        />
        {showCommandMenu ? (
          <div className="commandMenu" role="listbox" aria-label="可用命令">
            {filteredCommands.map((cmd, index) => (
              <button
                key={cmd.name}
                type="button"
                className={index === commandIndex ? "commandMenuItem isActive" : "commandMenuItem"}
                onClick={() => handlePickCommand(cmd.name)}
              >
                <span className="commandMenuName">{cmd.display}</span>
                {cmd.description || cmd.hint ? (
                  <span className="commandMenuHint">
                    {[cmd.description, cmd.hint].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="consoleActions">
          <div style={{ position: "relative" }} ref={configMenuRef}>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="consoleIconButton"
              onClick={() => setConfigMenuOpen((open) => !open)}
              disabled={!auth.user || !sessionId || displayConfigOptions.length === 0}
              aria-label="配置选项"
              title={
                !auth.user
                  ? "登录后可配置"
                  : !sessionId
                    ? "session 尚未建立"
                    : displayConfigOptions.length === 0
                      ? "暂无可配置选项（等待 Agent 上报 config_option_update）"
                      : "配置选项"
              }
            >
              {settingConfigOptionId ? <span className="iconSpinner" aria-hidden="true" /> : "⚙"}
            </Button>
            {configMenuOpen ? (
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  right: 0,
                  width: "min(72vw, 320px)",
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid var(--card-border)",
                  background: "var(--card-bg)",
                  boxShadow: "var(--shadow-soft)",
                  zIndex: 30,
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontWeight: 700 }}>配置</div>

                {displayConfigOptions.map((opt) => {
                  const optId = typeof opt.id === "string" ? opt.id : "";
                  const name =
                    typeof opt.name === "string" && opt.name.trim() ? opt.name.trim() : optId;
                  const currentValueStr =
                    opt.currentValue === undefined ? "-" : JSON.stringify(opt.currentValue);
                  const options = Array.isArray(opt.options) ? opt.options : [];

                  return (
                    <div
                      key={optId || name}
                      style={{
                        border: "1px solid var(--card-border)",
                        borderRadius: 10,
                        padding: 10,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div className="row spaceBetween" style={{ alignItems: "baseline", gap: 10 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {name}
                          </div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {optId ? `id=${optId} · ` : ""}
                            current={currentValueStr}
                          </div>
                        </div>
                        {settingConfigOptionId === optId ? (
                          <span className="iconSpinner" aria-hidden="true" />
                        ) : null}
                      </div>

                      {typeof opt.description === "string" && opt.description.trim() ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {opt.description.trim()}
                        </div>
                      ) : null}

                      <div style={{ display: "grid", gap: 6 }}>
                        {options.map((o, index) => {
                          const value = (o as any)?.value;
                          const label =
                            typeof (o as any)?.name === "string" && (o as any).name.trim()
                              ? String((o as any).name).trim()
                              : value === undefined
                                ? `option #${index + 1}`
                                : String(value);

                          const isActive =
                            typeof value === "string" && typeof opt.currentValue === "string"
                              ? value === opt.currentValue
                              : typeof value === "number" && typeof opt.currentValue === "number"
                                ? value === opt.currentValue
                                : typeof value === "boolean" && typeof opt.currentValue === "boolean"
                                  ? value === opt.currentValue
                                  : JSON.stringify(value) === JSON.stringify(opt.currentValue);

                          const description =
                            typeof (o as any)?.description === "string" ? (o as any).description.trim() : "";

                          return (
                            <Button
                              key={`${optId}:${label}:${index}`}
                              type="button"
                              variant="outline"
                              onClick={() => {
                                void onSetConfigOption(optId, value);
                                setConfigMenuOpen(false);
                              }}
                              disabled={!sessionId || !optId || settingConfigOptionId === optId}
                              className={`h-auto w-full items-start justify-start py-2 text-left ${isActive ? "border-primary" : ""}`}
                            >
                              <div style={{ display: "grid", gap: 2 }}>
                                <div style={{ fontWeight: 700 }}>{label}</div>
                                {description ? (
                                  <div className="muted" style={{ fontSize: 12 }}>
                                    {description}
                                  </div>
                                ) : null}
                              </div>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="consoleIconButton"
            onClick={onPause}
            disabled={!runId || pausing || !sessionId}
            aria-label="暂停"
            title="暂停"
          >
            {pausing ? <span className="iconSpinner" aria-hidden="true" /> : "⏸"}
          </Button>
          <Button
            type="submit"
            size="icon"
            className="consoleIconButton"
            disabled={
              !auth.user ||
              sending ||
              uploadingImages ||
              (!chatText.trim() && !pendingImages.length)
            }
            aria-label="发送"
            title="发送"
          >
            {sending || uploadingImages ? <span className="iconSpinner" aria-hidden="true" /> : "➤"}
          </Button>
        </div>
      </form>
      {sandboxHint ? (
        <div className={`consoleSendStatus ${sandboxHint.tone}`} title={sandboxTitle}>
          <span className="consoleSendDot" aria-hidden="true" />
          <span>{sandboxHint.label}</span>
        </div>
      ) : null}
    </section>
  );
}
