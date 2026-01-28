import { Link } from "react-router-dom";

import { RunConsole } from "../../../components/RunConsole";
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
    onPauseRun,
    onSendPrompt,
    pausing,
    run,
    sending,
    sessionKnown,
    setChatText,
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
      <RunConsole events={events} />
      <form onSubmit={onSendPrompt} className="consoleInput">
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
                    : "像 CLI 一样继续对话…"
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
            !chatText.trim() ||
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

