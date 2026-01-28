import { RunConsole } from "../../../components/RunConsole";
import { apiUrl } from "../../../api/client";
import type { SessionController } from "../useSessionController";

export function SessionConsoleCard(props: { model: SessionController }) {
  const {
    auth,
    chatText,
    events,
    issue,
    onDropFiles,
    onPause,
    onSend,
    pausing,
    pendingImages,
    removePendingImage,
    runId,
    sending,
    sessionId,
    setChatText,
    uploadingImages,
  } = props.model;

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
        onSubmit={onSend}
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
          placeholder={!auth.user ? "登录后可继续对话…" : "像 CLI 一样继续对话…（支持拖拽图片）"}
          disabled={!auth.user || sending}
        />
        <button type="submit" disabled={!auth.user || sending || uploadingImages || (!chatText.trim() && !pendingImages.length)}>
          发送
        </button>
      </form>
    </section>
  );
}
