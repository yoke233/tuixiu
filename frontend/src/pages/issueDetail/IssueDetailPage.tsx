import { useOutletContext, useParams } from "react-router-dom";

import type { IssuesOutletContext } from "@/pages/issueDetail/types";
import { useIssueDetailController } from "@/pages/issueDetail/useIssueDetailController";

import { ChangesArtifactsGrid } from "@/pages/issueDetail/sections/ChangesArtifactsGrid";
import { ConsoleCard } from "@/pages/issueDetail/sections/ConsoleCard";
import { IssueSummaryCard } from "@/pages/issueDetail/sections/IssueSummaryCard";
import { PageHeader } from "@/pages/issueDetail/sections/PageHeader";
import { RunCard } from "@/pages/issueDetail/sections/RunCard";
import { GlobalErrorToast } from "@/components/GlobalErrorToast";

export function IssueDetailPage() {
  const params = useParams();
  const issueId = params.id ?? "";
  const outlet = useOutletContext<IssuesOutletContext | null>();
  const model = useIssueDetailController({ issueId, outlet });

  return (
    <div className="container">
      <PageHeader model={model} />

      {model.error ? <GlobalErrorToast message={model.error} onDismiss={model.clearError} /> : null}

      {model.loading && !model.issue ? (
        <div className="muted">加载中…</div>
      ) : model.issue ? (
        <>
          <IssueSummaryCard model={model} />
          <ConsoleCard model={model} />
          <RunCard model={model} />
          <ChangesArtifactsGrid model={model} />
        </>
      ) : (
        <div className="muted">Issue 不存在</div>
      )}
    </div>
  );
}
