import type { IssueListController } from "../useIssueListController";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
            <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
              <SelectTrigger aria-label="选择 Project" className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div className="muted">
          {loading ? "加载中…" : effectiveProjectId ? `共 ${visibleIssues.length} 个 Issue` : "请先创建 Project"}
        </div>
      </div>
    </section>
  );
}
