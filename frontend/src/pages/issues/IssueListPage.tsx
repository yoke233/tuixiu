import { BoardHeader } from "./sections/BoardHeader";
import { IssueDetailOverlay } from "./sections/IssueDetailOverlay";
import { IssuesTopBar } from "./sections/IssuesTopBar";
import { KanbanBoard } from "./sections/KanbanBoard";
import { useIssueListController } from "./useIssueListController";

export function IssueListPage() {
  const model = useIssueListController();

  return (
    <div className={`issuesShell${model.hasDetail ? " hasDetail" : ""}`}>
      <IssuesTopBar model={model} />

      <div>
        {model.error ? (
          <div role="alert" className="alert">
            {model.error}
          </div>
        ) : null}
      </div>

      <div className={`issuesSplit ${model.hasDetail ? "hasDetail" : ""}`}>
        <main className="issuesBoard">
          <BoardHeader model={model} />
          <KanbanBoard model={model} />
        </main>
      </div>

      <IssueDetailOverlay model={model} />
    </div>
  );
}

