import type { IssueListController } from "../useIssueListController";

export function BoardHeader(props: { model: IssueListController }) {
  const {
    effectiveProjectId,
    loading,
    projects,
    selectedProjectId,
    setSelectedProjectId,
    visibleIssues,
  } = props.model;

  return (
    <section className="card boardHeader">
      <div className="row spaceBetween">
        <div className="row gap">
          <h2>看板</h2>
          {projects.length ? (
            <select
              aria-label="选择 Project"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="muted">
          {loading ? "加载中…" : effectiveProjectId ? `共 ${visibleIssues.length} 个 Issue` : "请先创建 Project"}
        </div>
      </div>
    </section>
  );
}

