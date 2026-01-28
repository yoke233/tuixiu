import { Link } from "react-router-dom";

import { RunConsole } from "../../../components/RunConsole";
import { apiUrl } from "../../../api/client";
import type { IssueDetailController } from "../useIssueDetailController";

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

  return (
    <section className="card">
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Console</h2>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          {currentRunId ? (
            <Link className="buttonSecondary" to={`/sessions/${currentRunId}`}>
              全屏控制台
            </Link>
          ) : null}
          {run?.executorType === "agent" && run?.status === "running" ? (
            <button
              onClick={onPauseRun}
              disabled={!allowPause || !currentRunId || pausing || !sessionKnown || (currentAgent ? !agentOnline : false)}
              title={!allowPause ? "需要开发或管理员权限" : !sessionKnown ? "ACP sessionId 尚未建立/同步" : ""}
            >
              {pausing ? "暂停中…" : "暂停 Agent"}
            </button>
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
        <RunConsole events={events} />
      </div>

      {pendingImages.length ? (
        <div className="row gap" style={{ flexWrap: "wrap", marginTop: 8 }}>
          {pendingImages.map((img) => (
            <div key={img.id} style={{ position: "relative" }}>
              <img
                src={apiUrl(img.uri)}
                alt={img.name ?? img.id}
                style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(255,255,255,0.12)" }}
              />
              <button
                type="button"
                onClick={() => removePendingImage(img.id)}
                className="buttonSecondary"
                style={{ position: "absolute", top: -8, right: -8, padding: "2px 6px", borderRadius: 999 }}
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
        <input
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
        <button
          type="submit"
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
        </button>
      </form>
      {currentRunId && run?.executorType === "agent" && currentAgent && !agentOnline ? (
        <div className="muted" style={{ marginTop: 8 }}>
          当前 Agent 离线：需要等待其重新上线，或重新启动新的 Run。
        </div>
      ) : currentRunId && run?.executorType === "agent" && !sessionKnown ? (
        <div className="muted" style={{ marginTop: 8 }}>
          ACP sessionId 还未同步到页面：proxy 会优先尝试复用/`session/load` 历史会话；仅在确实无法恢复时才会新建并注入上下文继续。
        </div>
      ) : null}
    </section>
  );
}
