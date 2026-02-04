import { useMemo } from "react";
import { Link } from "react-router-dom";

import { RunConsole } from "@/components/RunConsole";
import { apiUrl } from "@/api/client";
import { findLatestAcpTransportStatus } from "@/utils/acpTransport";
import { findLatestSandboxInstanceStatus } from "@/utils/sandboxStatus";
import type { IssueDetailController } from "@/pages/issueDetail/useIssueDetailController";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ConsoleCard(props: { model: IssueDetailController }) {
  const {
    auth,
    allowPause,
    allowRunActions,
    chatText,
    currentAgent,
    currentRunId,
    agentOnline,
    events,
    liveEventIds,
    onDropFiles,
    onPauseRun,
    onSendPrompt,
    pausing,
    pendingImages,
    removePendingImage,
    run,
    sending,
    sessionKnown,
    setChatText,
    uploadingImages,
  } = props.model;

  const sandboxStatus = useMemo(() => findLatestSandboxInstanceStatus(events), [events]);
  const transport = useMemo(() => findLatestAcpTransportStatus(events), [events]);
  const sessionOnline = Boolean(sessionKnown && transport?.connected);
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

  return (
    <section className="card">
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div className="row gap" style={{ alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Console</h2>
          <span
            className={sessionOnline ? "sessionOnlineDot isOnline" : "sessionOnlineDot isOffline"}
            title={sessionOnline ? "session 在线（可直接访问）" : "session 离线（不可直接访问）"}
            aria-label={sessionOnline ? "session online" : "session offline"}
          />
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          {currentRunId ? (
            <Button variant="secondary" size="sm" asChild>
              <Link to={`/sessions/${currentRunId}`}>全屏控制台</Link>
            </Button>
          ) : null}
          {run?.executorType === "agent" && run?.status === "running" ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onPauseRun}
              disabled={
                !allowPause ||
                !currentRunId ||
                pausing ||
                !sessionKnown ||
                (currentAgent ? !agentOnline : false)
              }
              title={
                !allowPause
                  ? "需要开发或管理员权限"
                  : !sessionKnown
                    ? "ACP sessionId 尚未建立/同步"
                    : ""
              }
            >
              {pausing ? "暂停中…" : "暂停 Agent"}
            </Button>
          ) : null}
        </div>
      </div>
      <div
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
              <Button
                type="button"
                onClick={() => removePendingImage(img.id)}
                variant="secondary"
                size="icon"
                className="h-6 w-6 rounded-full p-0"
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                }}
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
        onSubmit={onSendPrompt}
        className="consoleInput"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) void onDropFiles(e.dataTransfer.files);
        }}
      >
        <Input
          aria-label="对话输入"
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          placeholder={
            !auth.user
              ? "登录后可继续对话…"
              : !allowRunActions
                ? "当前账号无权限与 Agent 对话"
                : !currentRunId
                  ? "请先启动 Run"
                  : run?.executorType !== "agent"
                    ? "当前 Run 不是 Agent 执行器"
                    : "像 CLI 一样继续对话…（支持拖拽图片）"
          }
          disabled={
            !auth.user ||
            !allowRunActions ||
            !currentRunId ||
            sending ||
            run?.executorType !== "agent" ||
            (currentAgent ? !agentOnline : false)
          }
        />
        <Button
          type="submit"
          size="sm"
          disabled={
            !auth.user ||
            !allowRunActions ||
            !currentRunId ||
            sending ||
            uploadingImages ||
            (!chatText.trim() && !pendingImages.length) ||
            run?.executorType !== "agent" ||
            (currentAgent ? !agentOnline : false)
          }
        >
          发送
        </Button>
      </form>
      {sandboxHint ? (
        <div className={`consoleSendStatus ${sandboxHint.tone}`} title={sandboxTitle}>
          <span className="consoleSendDot" aria-hidden="true" />
          <span>{sandboxHint.label}</span>
        </div>
      ) : null}
      {currentRunId && run?.executorType === "agent" && currentAgent && !agentOnline ? (
        <div className="muted" style={{ marginTop: 8 }}>
          当前 Agent 离线：需要等待其重新上线，或重新启动新的 Run。
        </div>
      ) : currentRunId && run?.executorType === "agent" && !sessionKnown ? (
        <div className="muted" style={{ marginTop: 8 }}>
          ACP sessionId 还未同步到页面：proxy 会优先尝试复用/`session/load`
          历史会话；仅在确实无法恢复时才会新建并注入上下文继续。
        </div>
      ) : null}
    </section>
  );
}
