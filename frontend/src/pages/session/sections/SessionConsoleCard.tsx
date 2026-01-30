import { useEffect, useMemo, useRef, useState } from "react";

import { RunConsole } from "../../../components/RunConsole";
import { apiUrl } from "../../../api/client";
import { findLatestSandboxInstanceStatus } from "../../../utils/sandboxStatus";
import type { SessionController } from "../useSessionController";

export function SessionConsoleCard(props: { model: SessionController }) {
  const {
    auth,
    chatText,
    events,
    liveEventIds,
    issue,
    isAdmin,
    onSetMode,
    onDropFiles,
    onPause,
    onSend,
    pausing,
    pendingImages,
    removePendingImage,
    runId,
    sending,
    sessionState,
    sessionId,
    setChatText,
    settingMode,
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
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuDismissed, setCommandMenuDismissed] = useState(false);
  const [commandMenuForcedOpen, setCommandMenuForcedOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!modeMenuRef.current) return;
      if (!modeMenuRef.current.contains(event.target as Node)) setModeMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [modeMenuOpen]);

  const availableModes = useMemo(
    () => [
      {
        id: "ask",
        name: "Ask",
        description: "Request permission before making any changes",
      },
      {
        id: "architect",
        name: "Architect",
        description: "Design and plan software systems without implementation",
      },
      {
        id: "code",
        name: "Code",
        description: "Write and modify code with full tool access",
      },
    ],
    [],
  );
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
          <div style={{ fontWeight: 800 }}>Console</div>
          <div
            className="muted"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {issue?.title ?? "—"}
          </div>
        </div>
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
        <RunConsole events={events} liveEventIds={liveEventIds} />
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
              <button
                type="button"
                onClick={() => removePendingImage(img.id)}
                className="buttonSecondary"
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  padding: "2px 6px",
                  borderRadius: 999,
                }}
                aria-label="移除图片"
              >
                ×
              </button>
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
        <button
          type="button"
          className="buttonSecondary consoleIconButton consoleCommandButton"
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
        </button>
        <input
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
          <div style={{ position: "relative" }} ref={modeMenuRef}>
            <button
              type="button"
              className="buttonSecondary consoleIconButton"
              onClick={() => setModeMenuOpen((open) => !open)}
              disabled={!sessionId  || settingMode}
              aria-label="设置 mode"
              title={
                !sessionId
                  ? "session 尚未建立" : "设置 mode"
              }
            >
              {settingMode ? <span className="iconSpinner" aria-hidden="true" /> : "mode"}
            </button>
            {modeMenuOpen ? (
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
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 700 }}>设置 mode</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {sessionState?.currentModeId
                    ? `当前：${sessionState.currentModeId}`
                    : "当前：-"}
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {availableModes.map((mode) => {
                    const active = sessionState?.currentModeId === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        className="buttonSecondary"
                        onClick={() => {
                          void onSetMode(mode.id);
                          setModeMenuOpen(false);
                        }}
                        disabled={!sessionId || !isAdmin || settingMode}
                        style={{
                          textAlign: "left",
                          borderColor: active ? "var(--accent)" : undefined,
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{mode.name}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {mode.description}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="buttonSecondary consoleIconButton"
            onClick={onPause}
            disabled={!runId || pausing || !sessionId}
            aria-label="暂停"
            title="暂停"
          >
            {pausing ? <span className="iconSpinner" aria-hidden="true" /> : "⏸"}
          </button>
          <button
            type="submit"
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
          </button>
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
