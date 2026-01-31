import type { RunChangesController } from "../useRunChangesController";

import { Button } from "@/components/ui/button";

export function ChangesHeader(props: { model: RunChangesController }) {
  const {
    canUseApi,
    changes,
    createPrUrl,
    loading,
    mergeApproval,
    onApproveMerge,
    onAskAgentToFixMerge,
    onAutoReview,
    onCreatePr,
    onMergePr,
    onRejectMerge,
    onSyncPr,
    prInfo,
    prLoading,
    providerLabel,
    refresh,
    reviewLoading,
  } = props.model;

  return (
    <div className="row spaceBetween" style={{ alignItems: "center" }}>
      <div className="muted" style={{ fontSize: 12 }}>
        {changes ? `${changes.baseBranch} → ${changes.branch} · ${changes.files.length} files` : "变更与 diff"}
      </div>
      <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button type="button" variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          刷新
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onAutoReview} disabled={reviewLoading}>
          {reviewLoading ? "验收中…" : "自动验收"}
        </Button>
        {prInfo ? (
          <>
            <Button asChild variant="secondary" size="sm">
              <a href={prInfo.webUrl || "#"} target="_blank" rel="noreferrer">
                打开 {providerLabel}
                {prInfo.num ? ` #${prInfo.num}` : ""}
              </a>
            </Button>
            {canUseApi ? (
              <>
                <Button type="button" size="sm" onClick={onSyncPr} disabled={prLoading}>
                  同步 {providerLabel} 状态
                </Button>
                {prInfo.mergeableState === "dirty" || prInfo.mergeableState === "behind" ? (
                  <Button type="button" size="sm" onClick={onAskAgentToFixMerge} disabled={prLoading}>
                    让 Agent {prInfo.mergeableState === "dirty" ? "解决冲突" : "更新分支"}
                  </Button>
                ) : null}
                {mergeApproval?.content?.status === "pending" ? (
                  <>
                    <span className="muted" style={{ marginLeft: 4 }}>
                      待审批
                    </span>
                    <Button type="button" size="sm" onClick={onApproveMerge} disabled={prLoading}>
                      批准并合并
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={onRejectMerge} disabled={prLoading}>
                      拒绝
                    </Button>
                  </>
                ) : mergeApproval?.content?.status === "executing" ? (
                  <Button type="button" size="sm" variant="secondary" disabled>
                    正在合并…
                  </Button>
                ) : mergeApproval?.content?.status === "executed" ? (
                  <Button type="button" size="sm" variant="secondary" disabled>
                    已合并
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    onClick={onMergePr}
                    disabled={prLoading || prInfo.mergeableState === "dirty" || prInfo.mergeable === false}
                  >
                    发起合并审批
                  </Button>
                )}
              </>
            ) : null}
          </>
        ) : canUseApi ? (
          <Button type="button" size="sm" onClick={onCreatePr} disabled={prLoading}>
            创建 {providerLabel}
          </Button>
        ) : createPrUrl ? (
          <Button asChild variant="secondary" size="sm">
            <a href={createPrUrl} target="_blank" rel="noreferrer">
              打开 PR 页面
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
