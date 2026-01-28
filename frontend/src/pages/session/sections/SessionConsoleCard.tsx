import { RunConsole } from "../../../components/RunConsole";
import type { SessionController } from "../useSessionController";

export function SessionConsoleCard(props: { model: SessionController }) {
  const { auth, chatText, events, issue, onPause, onSend, pausing, runId, sending, sessionId, setChatText } = props.model;

  return (
    <section className="card sessionConsoleCard">
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800 }}>Console</div>
          <div className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {issue?.title ?? "—"}
          </div>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="buttonSecondary" onClick={onPause} disabled={!runId || pausing || !sessionId}>
            {pausing ? "暂停中…" : "暂停"}
          </button>
        </div>
      </div>

      <div className="sessionConsoleBody">
        <RunConsole events={events} />
      </div>

      <form onSubmit={onSend} className="consoleInput">
        <input
          aria-label="对话输入"
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          placeholder={!auth.user ? "登录后可继续对话…" : "像 CLI 一样继续对话…"}
          disabled={!auth.user || sending}
        />
        <button type="submit" disabled={!auth.user || sending || !chatText.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}

