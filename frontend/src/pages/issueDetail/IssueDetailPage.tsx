import { useOutletContext, useParams } from "react-router-dom";

import type { IssuesOutletContext } from "./types";
import { useIssueDetailController } from "./useIssueDetailController";

import { ChangesArtifactsGrid } from "./sections/ChangesArtifactsGrid";
import { ConsoleCard } from "./sections/ConsoleCard";
import { IssueSummaryCard } from "./sections/IssueSummaryCard";
import { PageHeader } from "./sections/PageHeader";
import { PmDetails } from "./sections/PmDetails";
import { RunCard } from "./sections/RunCard";
import { TasksDetails } from "./sections/TasksDetails";

export function IssueDetailPage() {
  const params = useParams();
  const issueId = params.id ?? "";
  const outlet = useOutletContext<IssuesOutletContext | null>();
  const model = useIssueDetailController({ issueId, outlet });

  return (
    <div className="container">
      <PageHeader model={model} />

      {model.error ? (
        <div role="alert" className="alert">
          {model.error}
        </div>
      ) : null}

      {model.loading && !model.issue ? (
        <div className="muted">加载中…</div>
      ) : model.issue ? (
        <>
          <IssueSummaryCard model={model} />
          <ConsoleCard model={model} />
          <TasksDetails model={model} />
          <PmDetails model={model} />
          <RunCard model={model} />
          <ChangesArtifactsGrid model={model} />
        </>
      ) : (
        <div className="muted">Issue 不存在</div>
      )}
    </div>
  );
}

