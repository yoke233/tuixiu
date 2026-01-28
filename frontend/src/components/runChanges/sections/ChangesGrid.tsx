import type { RunChangesController } from "../useRunChangesController";

export function ChangesGrid(props: { model: RunChangesController }) {
  const { changes, diff, diffLoading, loading, selectedPath, setSelectedPath } = props.model;

  if (loading) return <div className="muted">加载变更中…</div>;
  if (!changes) return <div className="muted">暂无变更信息（需要 branch 产物或已推送分支）</div>;

  return (
    <div className="changesGrid">
      <div className="changesFiles" role="list" aria-label="变更文件列表">
        {changes.files.length ? (
          changes.files.map((f) => {
            const active = selectedPath === f.path;
            return (
              <button
                key={`${f.status}:${f.oldPath ?? ""}:${f.path}`}
                type="button"
                className={`fileRow ${active ? "active" : ""}`}
                onClick={() => setSelectedPath(f.path)}
              >
                <code className="fileStatus">{f.status}</code>
                <span className="filePath" title={f.path}>
                  {f.path}
                </span>
              </button>
            );
          })
        ) : (
          <div className="muted">暂无变更</div>
        )}
      </div>

      <div className="changesDiff" aria-label="Diff">
        {diffLoading ? <div className="muted">加载 diff…</div> : diff ? <pre className="pre">{diff}</pre> : <div className="muted">请选择文件</div>}
      </div>
    </div>
  );
}

