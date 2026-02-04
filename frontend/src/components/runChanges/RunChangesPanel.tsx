import { ChangesGrid } from "@/components/runChanges/sections/ChangesGrid";
import { ChangesHeader } from "@/components/runChanges/sections/ChangesHeader";
import { useRunChangesController } from "@/components/runChanges/useRunChangesController";
import type { RunChangesController } from "@/components/runChanges/useRunChangesController";

type Props = Parameters<typeof useRunChangesController>[0];

function PrStatusLine(props: { model: RunChangesController }) {
  const { prInfo, providerLabel } = props.model;
  if (!prInfo) return null;

  return (
    <div className="muted" style={{ marginTop: 6 }}>
      {providerLabel} 状态：
      {prInfo.state || "未知"}
      {prInfo.mergeableState === "dirty"
        ? "（有合并冲突）"
        : prInfo.mergeableState
          ? `（mergeable_state: ${prInfo.mergeableState}）`
          : prInfo.mergeable === true
            ? "（可合并）"
            : prInfo.mergeable === false
              ? "（不可合并）"
              : ""}
    </div>
  );
}

export function RunChangesPanel(props: Props) {
  const model = useRunChangesController(props);

  if (!model.runId) {
    return <div className="muted">暂无 Run</div>;
  }

  return (
    <div>
      <ChangesHeader model={model} />
      <PrStatusLine model={model} />

      {model.error ? (
        <div role="alert" className="alert" style={{ marginTop: 10 }}>
          {model.error}
        </div>
      ) : null}

      <ChangesGrid model={model} />
    </div>
  );
}

