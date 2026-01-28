import { Fragment } from "react";

import { StatusBadge } from "../../../components/StatusBadge";
import type { TaskTrack } from "../../../types";
import type { IssueDetailController } from "../useIssueDetailController";

export function TasksDetails(props: { model: IssueDetailController }) {
  const {
    auth,
    allowTaskOps,
    canCreateAnotherTask,
    creatingTask,
    currentRunId,
    getHumanForm,
    latestRunForStep,
    onCreateTask,
    onRollback,
    onSelectRun,
    onStartStep,
    onSubmitHuman,
    patchHumanForm,
    refresh,
    refreshing,
    roleAllowsHumanSubmit,
    rollingBackStepId,
    selectedTaskTrack,
    selectedTemplateKey,
    setSelectedTaskTrack,
    setSelectedTemplateKey,
    startingStepId,
    submittingRunId,
    taskTemplatesError,
    taskTemplatesLoaded,
    tasks,
    tasksError,
    tasksLoaded,
    templatesByKey,
    visibleTaskTemplatesByTrack,
  } = props.model;

  return (
    <details className="card">
      <summary className="detailsSummary">
        <div className="row spaceBetween" style={{ alignItems: "center" }}>
          <span className="toolSummaryTitle">任务</span>
          <span className="muted">{tasksLoaded ? `共 ${tasks.length} 个` : "加载中…"}</span>
        </div>
      </summary>
      <div className="row spaceBetween" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h2 className="srOnly">任务</h2>
          <div className="muted">Task/Step（支持回滚重跑与多执行器）</div>
        </div>
        <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
          {canCreateAnotherTask ? (
            <>
              <select
                aria-label="选择任务模板"
                value={selectedTemplateKey}
                onChange={(e) => setSelectedTemplateKey(e.target.value)}
                disabled={!taskTemplatesLoaded && !taskTemplatesError}
              >
                <option value="">选择模板…</option>
                {visibleTaskTemplatesByTrack.quick.length ? (
                  <optgroup label="Track：quick">
                    {visibleTaskTemplatesByTrack.quick.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {visibleTaskTemplatesByTrack.planning.length ? (
                  <optgroup label="Track：planning">
                    {visibleTaskTemplatesByTrack.planning.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {visibleTaskTemplatesByTrack.enterprise.length ? (
                  <optgroup label="Track：enterprise">
                    {visibleTaskTemplatesByTrack.enterprise.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {visibleTaskTemplatesByTrack.other.length ? (
                  <optgroup label="其他">
                    {visibleTaskTemplatesByTrack.other.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.displayName}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
              <select
                aria-label="选择 Track"
                value={selectedTaskTrack}
                onChange={(e) => setSelectedTaskTrack(e.target.value as TaskTrack | "")}
                disabled={creatingTask}
              >
                <option value="">Track：自动</option>
                <option value="quick">Track：quick</option>
                <option value="planning">Track：planning</option>
                <option value="enterprise">Track：enterprise</option>
              </select>
              <button
                type="button"
                onClick={onCreateTask}
                disabled={creatingTask || !selectedTemplateKey || !allowTaskOps}
                title={!allowTaskOps ? "需要开发或管理员权限" : undefined}
              >
                {creatingTask ? "创建中…" : "创建任务"}
              </button>
            </>
          ) : (
            <span className="muted">
              {!tasksLoaded
                ? "Task 加载中：暂不可创建"
                : tasksError
                  ? "Task 加载失败：暂不可创建"
                  : "已有进行中的 Task：请在下方继续执行/回滚重跑"}
            </span>
          )}
          <button type="button" className="buttonSecondary" onClick={() => refresh()} disabled={refreshing}>
            同步
          </button>
        </div>
      </div>

      {taskTemplatesError ? (
        <div className="muted" style={{ marginTop: 8 }} title={taskTemplatesError}>
          模板加载失败：{taskTemplatesError}
        </div>
      ) : null}
      {tasksError ? (
        <div className="muted" style={{ marginTop: 8 }} title={tasksError}>
          Task 加载失败：{tasksError}
        </div>
      ) : null}

      {!tasksLoaded ? (
        <div className="muted" style={{ marginTop: 10 }}>
          加载中…
        </div>
      ) : tasks.length ? (
        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          {tasks.map((t, idx) => {
            const template = templatesByKey[t.templateKey];
            return (
              <details key={t.id} open={idx === 0}>
                <summary className="detailsSummary">
                  <div className="row spaceBetween" style={{ alignItems: "center" }}>
                    <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                      <span className="toolSummaryTitle">{template?.displayName ?? t.templateKey}</span>
                      <StatusBadge status={t.status} />
                      {t.track ? <code title={`track: ${t.track}`}>{t.track}</code> : null}
                      {t.branchName ? <code title={t.branchName}>{t.branchName}</code> : null}
                    </div>
                    <span className="muted">{new Date(t.createdAt).toLocaleString()}</span>
                  </div>
                </summary>

                <div className="muted" style={{ marginTop: 8 }}>
                  taskId: <code title={t.id}>{t.id}</code>
                  {t.track ? (
                    <>
                      {" "}
                      · track: <code>{t.track}</code>
                    </>
                  ) : null}
                </div>

                <div className="tableScroll">
                  <table className="table" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Step</th>
                        <th>执行器</th>
                        <th>状态</th>
                        <th>Run</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.steps.map((s) => {
                        const latest = latestRunForStep(s.id);
                        const viewing = latest?.id ? currentRunId === latest.id : false;
                        const role = auth.user?.role ?? null;
                        const canSubmit = roleAllowsHumanSubmit(s.kind, role);
                        const form = latest?.id ? getHumanForm(latest.id) : null;

                        return (
                          <Fragment key={s.id}>
                            <tr>
                              <td>{s.order}</td>
                              <td>
                                <div>
                                  <code title={s.key}>{s.key}</code>
                                </div>
                                <div className="muted" style={{ fontSize: 12 }}>
                                  {s.kind}
                                </div>
                              </td>
                              <td>
                                <code>{s.executorType}</code>
                              </td>
                              <td>
                                <StatusBadge status={s.status} />
                              </td>
                              <td>
                                {latest ? (
                                  <div style={{ display: "grid", gap: 4 }}>
                                    <code title={latest.id}>{latest.id}</code>
                                    <span className="muted" style={{ fontSize: 12 }}>
                                      {latest.status}
                                      {typeof latest.attempt === "number" ? ` · attempt ${latest.attempt}` : ""}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>
                                <div className="row gap" style={{ flexWrap: "wrap" }}>
                                  {latest?.id ? (
                                    <button
                                      type="button"
                                      className="buttonSecondary"
                                      onClick={() => void onSelectRun(latest.id)}
                                      disabled={viewing}
                                    >
                                      {viewing ? "查看中" : "查看"}
                                    </button>
                                  ) : null}

                                  <button
                                    type="button"
                                    onClick={() => void onStartStep(s)}
                                    disabled={!allowTaskOps || s.status !== "ready" || startingStepId === s.id}
                                    title={!allowTaskOps ? "需要开发或管理员权限" : undefined}
                                  >
                                    {startingStepId === s.id ? "启动中…" : "启动"}
                                  </button>

                                  <button
                                    type="button"
                                    className="buttonSecondary"
                                    onClick={() => void onRollback(t, s)}
                                    disabled={!allowTaskOps || rollingBackStepId === s.id}
                                    title={!allowTaskOps ? "需要开发或管理员权限" : undefined}
                                  >
                                    {rollingBackStepId === s.id ? "回滚中…" : "回滚到此步"}
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {s.status === "waiting_human" && latest?.id && latest.executorType === "human" ? (
                              <tr>
                                <td colSpan={6}>
                                  <div className="row gap" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                                    {s.kind === "pr.merge" ? (
                                      <>
                                        <label className="label" style={{ margin: 0 }}>
                                          squash
                                          <input
                                            type="checkbox"
                                            checked={Boolean(form?.squash)}
                                            onChange={(e) => patchHumanForm(latest.id, { squash: e.target.checked })}
                                            disabled={submittingRunId === latest.id}
                                          />
                                        </label>
                                        <label className="label" style={{ margin: 0, flex: "1 1 320px", minWidth: 0 }}>
                                          merge message（可选）
                                          <input
                                            value={form?.mergeCommitMessage ?? ""}
                                            onChange={(e) =>
                                              patchHumanForm(latest.id, { mergeCommitMessage: e.target.value })
                                            }
                                            disabled={submittingRunId === latest.id}
                                            placeholder="留空使用默认"
                                          />
                                        </label>
                                        <button
                                          type="button"
                                          onClick={() => void onSubmitHuman(s, latest.id)}
                                          disabled={!canSubmit || submittingRunId === latest.id}
                                        >
                                          {submittingRunId === latest.id ? "合并中…" : "合并"}
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <label className="label" style={{ margin: 0 }}>
                                          verdict
                                          <select
                                            value={form?.verdict ?? "approve"}
                                            onChange={(e) =>
                                              patchHumanForm(latest.id, {
                                                verdict: e.target.value as "approve" | "changes_requested",
                                              })
                                            }
                                            disabled={submittingRunId === latest.id}
                                          >
                                            <option value="approve">approve</option>
                                            <option value="changes_requested">changes_requested</option>
                                          </select>
                                        </label>
                                        <label className="label" style={{ margin: 0, flex: "1 1 360px", minWidth: 0 }}>
                                          comment（Markdown，可选）
                                          <textarea
                                            value={form?.comment ?? ""}
                                            onChange={(e) => patchHumanForm(latest.id, { comment: e.target.value })}
                                            disabled={submittingRunId === latest.id}
                                            placeholder="写评审意见/修改建议…"
                                          />
                                        </label>
                                        <button
                                          type="button"
                                          onClick={() => void onSubmitHuman(s, latest.id)}
                                          disabled={!canSubmit || submittingRunId === latest.id}
                                        >
                                          {submittingRunId === latest.id ? "提交中…" : "提交"}
                                        </button>
                                      </>
                                    )}
                                    {!canSubmit ? <span className="muted">当前账号无权限提交该步骤</span> : null}
                                  </div>
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 10 }}>
          暂无 Task（可从模板创建）
        </div>
      )}
    </details>
  );
}

