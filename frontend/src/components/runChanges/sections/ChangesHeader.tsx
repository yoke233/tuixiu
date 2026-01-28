import type { RunChangesController } from "../useRunChangesController";

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
        <button onClick={refresh} disabled={loading}>
          刷新
        </button>
        <button onClick={onAutoReview} disabled={reviewLoading}>
          {reviewLoading ? "验收中…" : "自动验收"}
        </button>
        {prInfo ? (
          <>
            <a className="buttonSecondary" href={prInfo.webUrl || "#"} target="_blank" rel="noreferrer">
              打开 {providerLabel}
              {prInfo.num ? ` #${prInfo.num}` : ""}
            </a>
            {canUseApi ? (
              <>
                <button onClick={onSyncPr} disabled={prLoading}>
                  同步 {providerLabel} 状态
                </button>
                {prInfo.mergeableState === "dirty" || prInfo.mergeableState === "behind" ? (
                  <button onClick={onAskAgentToFixMerge} disabled={prLoading}>
                    让 Agent {prInfo.mergeableState === "dirty" ? "解决冲突" : "更新分支"}
                  </button>
                ) : null}
                {mergeApproval?.content?.status === "pending" ? (
                  <>
                    <span className="muted" style={{ marginLeft: 4 }}>
                      待审批
                    </span>
                    <button onClick={onApproveMerge} disabled={prLoading}>
                      批准并合并
                    </button>
                    <button onClick={onRejectMerge} disabled={prLoading}>
                      拒绝
                    </button>
                  </>
                ) : mergeApproval?.content?.status === "executing" ? (
                  <button disabled>正在合并…</button>
                ) : mergeApproval?.content?.status === "executed" ? (
                  <button disabled>已合并</button>
                ) : (
                  <button onClick={onMergePr} disabled={prLoading || prInfo.mergeableState === "dirty" || prInfo.mergeable === false}>
                    发起合并审批
                  </button>
                )}
              </>
            ) : null}
          </>
        ) : canUseApi ? (
          <button onClick={onCreatePr} disabled={prLoading}>
            创建 {providerLabel}
          </button>
        ) : createPrUrl ? (
          <a className="buttonSecondary" href={createPrUrl} target="_blank" rel="noreferrer">
            打开 PR 页面
          </a>
        ) : null}
      </div>
    </div>
  );
}

