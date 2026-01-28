import { ArtifactList } from "../../../components/ArtifactList";
import { RunChangesPanel } from "../../../components/RunChangesPanel";
import type { IssueDetailController } from "../useIssueDetailController";

export function ChangesArtifactsGrid(props: { model: IssueDetailController }) {
  const {
    changesOpen,
    issue,
    refresh,
    run,
    runArtifacts,
    setChangesOpen,
    setRun,
    showArtifacts,
    showChanges,
  } = props.model;

  if (!issue) return null;
  if (!showChanges && !showArtifacts) return null;

  return (
    <div className="grid2">
      {showChanges ? (
        <section className="card">
          <details
            onToggle={(e) => {
              setChangesOpen((e.currentTarget as HTMLDetailsElement).open);
            }}
          >
            <summary className="detailsSummary">变更</summary>
            {changesOpen ? (
              <RunChangesPanel
                runId={run?.id ?? ""}
                run={run}
                project={issue.project}
                onRunUpdated={setRun}
                onAfterAction={() => refresh({ silent: true })}
              />
            ) : (
              <div className="muted" style={{ padding: "10px 0" }}>
                展开后加载变更与 diff
              </div>
            )}
          </details>
        </section>
      ) : null}

      {showArtifacts ? (
        <section className="card">
          <details>
            <summary className="detailsSummary">交付物{runArtifacts.length ? ` (${runArtifacts.length})` : ""}</summary>
            <ArtifactList artifacts={runArtifacts} />
          </details>
        </section>
      ) : null}
    </div>
  );
}

