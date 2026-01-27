import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";

import { listIssues, startIssue, updateIssue } from "../api/issues";
import { listProjects } from "../api/projects";
import { cancelRun, completeRun } from "../api/runs";
import { useAuth } from "../auth/AuthContext";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Issue, IssueStatus, Project } from "../types";
import { canChangeIssueStatus, canRunIssue } from "../utils/permissions";
import { getShowArchivedIssues } from "../utils/settings";

const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  pending: "To Do",
  running: "In Progress",
  reviewing: "In Review",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled"
};

function hasStringLabel(labels: unknown, needle: string): boolean {
  if (!Array.isArray(labels)) return false;
  const expected = needle.trim().toLowerCase();
  return labels.some((x) => typeof x === "string" && x.trim().toLowerCase() === expected);
}

export function IssueListPage() {
  const params = useParams();
  const selectedIssueId = params.id ?? "";
  const hasDetail = !!selectedIssueId;
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const userRole = auth.user?.role ?? null;
  const canRun = canRunIssue(userRole);
  const canChangeStatus = canChangeIssueStatus(userRole);
  const showIssueActionsButton = !auth.user || canRun || canChangeStatus;

  const [dragging, setDragging] = useState<{
    issueId: string;
    fromStatus: IssueStatus;
    runId?: string;
  } | null>(null);
  const [dropStatus, setDropStatus] = useState<IssueStatus | null>(null);
  const [moving, setMoving] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionIssueId, setActionIssueId] = useState<string>("");

  const onIssueUpdated = useCallback((issue: Issue) => {
    setIssues((prev) => {
      const idx = prev.findIndex((x) => x.id === issue.id);
      if (idx === -1) return [issue, ...prev];
      const next = [...prev];
      next[idx] = issue;
      return next;
    });
  }, []);

  const outletContext = useMemo(() => ({ onIssueUpdated }), [onIssueUpdated]);

  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [showArchivedOnBoard] = useState<boolean>(() => getShowArchivedIssues());
  const [searchText, setSearchText] = useState("");
  const closeDetail = useCallback(() => {
    navigate("/issues", { replace: true });
  }, [navigate]);

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

  const visibleIssues = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    const filtered = issues.filter(
      (i) =>
        i.projectId === effectiveProjectId &&
        (showArchivedOnBoard || !i.archivedAt) &&
        !hasStringLabel(i.labels, "_session")
    );
    if (!needle) return filtered;
    return filtered.filter((i) => {
      const t = `${i.title ?? ""}\n${i.description ?? ""}`.toLowerCase();
      return t.includes(needle);
    });
  }, [effectiveProjectId, issues, searchText, showArchivedOnBoard]);

  const issuesByStatus = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = {
      pending: [],
      running: [],
      reviewing: [],
      done: [],
      failed: [],
      cancelled: []
    };
    for (const i of visibleIssues) {
      map[i.status]?.push(i);
    }
    for (const key of Object.keys(map) as IssueStatus[]) {
      map[key].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return map;
  }, [visibleIssues]);

  const actionIssue = useMemo(() => {
    if (!actionIssueId) return null;
    return issues.find((i) => i.id === actionIssueId) ?? null;
  }, [actionIssueId, issues]);

  const actionIssueRunId = actionIssue?.runs?.[0]?.id ?? "";

  type IssuePrimaryAction = { key: string; label: string; toStatus: IssueStatus; variant?: "danger" };
  type IssueStatusAction = {
    key: string;
    label: string;
    toStatus: Exclude<IssueStatus, "running">;
    disabled?: boolean;
  };

  const issueActions = useMemo<{ primary: IssuePrimaryAction[]; statuses: IssueStatusAction[] }>(() => {
    if (!actionIssue) {
      return {
        primary: [],
        statuses: []
      };
    }

    if (actionIssue.status === "running") {
      return {
        primary: canRun
          ? [
              { key: "to_reviewing", label: "完成 Run（进入 In Review）", toStatus: "reviewing" },
              { key: "cancel_run", label: "取消 Run", toStatus: "cancelled", variant: "danger" }
            ]
          : [],
        statuses: []
      };
    }

    const startLabel = actionIssue.status === "done" || actionIssue.status === "failed" || actionIssue.status === "cancelled"
      ? "重新启动 Run"
      : "启动 Run";
    const statuses: Array<Exclude<IssueStatus, "running">> = ["pending", "reviewing", "done", "failed", "cancelled"];
    return {
      primary: canRun ? [{ key: "start_run", label: startLabel, toStatus: "running" }] : [],
      statuses: canChangeStatus
        ? statuses.map((s) => ({
            key: `to_${s}`,
            label: `移到 ${ISSUE_STATUS_LABELS[s]}`,
            toStatus: s,
            disabled: s === actionIssue.status
          }))
        : []
    };
  }, [actionIssue, canChangeStatus, canRun]);

  function openIssueActions(issueId: string) {
    setActionIssueId(issueId);
  }

  function closeIssueActions() {
    setActionIssueId("");
  }

  useEffect(() => {
    if (!actionIssueId) return;
    if (actionIssue) return;
    setActionIssueId("");
  }, [actionIssue, actionIssueId]);

  useEffect(() => {
    if (!actionIssueId) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeIssueActions();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [actionIssueId]);

  useEffect(() => {
    if (!hasDetail) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeDetail, hasDetail]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [ps, is] = await Promise.all([listProjects(), listIssues()]);
      setProjects(ps);
      setIssues(is.issues);
      if (!selectedProjectId && ps[0]?.id) setSelectedProjectId(ps[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function readDragPayload(e: React.DragEvent): typeof dragging {
    try {
      const raw = e.dataTransfer.getData("application/json");
      if (!raw) return null;
      const v = JSON.parse(raw) as any;
      if (!v || typeof v !== "object") return null;
      if (typeof v.issueId !== "string") return null;
      if (typeof v.fromStatus !== "string") return null;
      const issueId = v.issueId as string;
      const fromStatus = v.fromStatus as IssueStatus;
      const runId = typeof v.runId === "string" && v.runId ? (v.runId as string) : undefined;
      return { issueId, fromStatus, runId };
    } catch {
      return null;
    }
  }

  async function moveIssue(payload: NonNullable<typeof dragging>, toStatus: IssueStatus) {
    if (!payload.issueId) return;
    if (payload.fromStatus === toStatus) return;
    if (!auth.user) {
      const next = encodeURIComponent(`${location.pathname}${location.search}`);
      navigate(`/login?next=${next}`);
      return;
    }

    const isRunAction = payload.fromStatus === "running" || toStatus === "running";
    if (isRunAction && !canRun) {
      setError("当前账号无权限操作 Run");
      return;
    }
    if (!isRunAction && !canChangeStatus) {
      setError("当前账号无权限变更 Issue 状态");
      return;
    }

    setMoving(true);
    setError(null);
    try {
      if (toStatus === "running") {
        await startIssue(payload.issueId, {});
        await refresh();
        return;
      }

      if (payload.fromStatus === "running") {
        if (!payload.runId) {
          throw new Error("缺少 runId，无法变更运行中状态");
        }
        if (toStatus === "reviewing") {
          await completeRun(payload.runId);
          await refresh();
          return;
        }
        if (toStatus === "cancelled") {
          await cancelRun(payload.runId);
          await refresh();
          return;
        }
        throw new Error("运行中 Issue 只能拖到 In Review 或 Cancelled");
      }

      await updateIssue(payload.issueId, { status: toStatus });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
      setDragging(null);
      setDropStatus(null);
    }
  }

  async function runIssueAction(toStatus: IssueStatus) {
    if (!actionIssue) return;
    closeIssueActions();
    const latestRun = actionIssue.runs?.[0];
    await moveIssue({ issueId: actionIssue.id, fromStatus: actionIssue.status, runId: latestRun?.id }, toStatus);
  }

  const columns = useMemo(
    () =>
      [
        { key: "pending", title: "To Do", dot: "dotGray" },
        { key: "running", title: "In Progress", dot: "dotBlue" },
        { key: "reviewing", title: "In Review", dot: "dotPurple" },
        { key: "done", title: "Done", dot: "dotGreen" },
        { key: "failed", title: "Failed", dot: "dotRed" },
        { key: "cancelled", title: "Cancelled", dot: "dotGray" },
      ] as const,
    []
  );

  return (
    <div className={`issuesShell${hasDetail ? " hasDetail" : ""}`}>
      <div className="issuesTopBar">
        <div className="row gap">
          <div>
            <h1>ACP 协作台</h1>
            <div className="muted">项目看板 / 需求池 / 执行面板</div>
          </div>
        </div>

        <div className="row gap issuesTopActions">
          <label className="srOnly" htmlFor="issueSearch">
            搜索 Issue
          </label>
          <input
            id="issueSearch"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="搜索 Issue…"
          />
          <ThemeToggle />
          {auth.user ? (
            <div className="row gap" style={{ alignItems: "baseline" }}>
              <span className="muted" title={auth.user.id}>
                {auth.user.username} ({auth.user.role})
              </span>
               {auth.hasRole(["admin"]) ? (
                <>
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => navigate("/admin?section=issues#issue-create")}
                  >
                    新建 Issue
                  </button>
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => navigate("/admin?section=issues#issue-github-import")}
                  >
                    GitHub 导入
                  </button>
                  <button
                    type="button"
                    className="buttonSecondary"
                    onClick={() => navigate("/admin?section=acpSessions")}
                  >
                    Sessions
                  </button>
                  <button type="button" className="buttonSecondary" onClick={() => navigate("/admin")}>
                    管理
                  </button>
                </>
              ) : null}
              <button type="button" className="buttonSecondary" onClick={() => auth.logout()}>
                退出
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="buttonSecondary"
              onClick={() => navigate(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`)}
            >
              登录
            </button>
          )}
          <button onClick={() => refresh()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      <div>
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
      </div>

      <div className={`issuesSplit ${hasDetail ? "hasDetail" : ""}`}>
        <main className="issuesBoard">
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

          <section className="kanban" aria-label="Issues 看板">
            {columns.map((c) => {
              const list = issuesByStatus[c.key];
              return (
                <div
                  key={c.key}
                  className={`kanbanCol ${dropStatus === c.key ? "dropTarget" : ""}`}
                  aria-label={c.title}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropStatus(c.key);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const payload = readDragPayload(e);
                    if (!payload) return;
                    void moveIssue(payload, c.key);
                  }}
                >
                  <div className="kanbanColHeader">
                    <div className="row gap">
                      <span className={`dot ${c.dot}`} aria-hidden="true" />
                      <div className="kanbanColTitle">{c.title}</div>
                    </div>
                    <div className="muted">{list.length}</div>
                  </div>

                  <div className="kanbanColBody">
                    {list.length ? (
                      list.map((i) => {
                        const latestRun = i.runs?.[0];
                        const selected = selectedIssueId === i.id;
                        const isDragging = dragging?.issueId === i.id;
                        return (
                          <div key={i.id} className="issueCardWrap">
                             <Link
                               to={`/issues/${i.id}`}
                               draggable={Boolean(auth.user) && (canRun || canChangeStatus)}
                               onDragStart={(e) => {
                                 if (!auth.user) return;
                                 if (!canRun && !canChangeStatus) return;
                                 const payload = { issueId: i.id, fromStatus: i.status, runId: latestRun?.id };
                                 setDragging(payload);
                                 e.dataTransfer.setData("application/json", JSON.stringify(payload));
                                 e.dataTransfer.effectAllowed = "move";
                               }}
                              onDragEnd={() => {
                                setDragging(null);
                                setDropStatus(null);
                              }}
                              className={`issueCard ${selected ? "selected" : ""} ${isDragging ? "dragging" : ""}`}
                              aria-disabled={moving ? "true" : undefined}
                            >
                              <div className="issueTitle" title={i.title}>
                                {i.title}
                              </div>
                              <div className="row spaceBetween issueMeta">
                                <div className="muted">{new Date(i.createdAt).toLocaleDateString()}</div>
                                {latestRun ? (
                                  <div className="row gap issueCardRun" title={`最新 Run：${latestRun.id}`}>
                                    <span className="muted" style={{ fontSize: 12 }}>
                                      Run
                                    </span>
                                    <StatusBadge status={latestRun.status} />
                                  </div>
                                ) : (
                                  <span className="muted" style={{ fontSize: 12 }}>
                                    Run —
                                  </span>
                                )}
                              </div>
                            </Link>
                             {showIssueActionsButton ? (
                               <button
                                 type="button"
                                 className="buttonSecondary issueCardAction"
                                 aria-label={`操作：${i.title}`}
                                 onClick={(e) => {
                                   e.preventDefault();
                                   e.stopPropagation();
                                   openIssueActions(i.id);
                                 }}
                                 disabled={moving}
                               >
                                 ⋯
                               </button>
                             ) : null}
                           </div>
                         );
                       })
                     ) : (
                      <div className="muted kanbanEmpty">暂无</div>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        </main>
      </div>

      {hasDetail ? (
        <div
          className="modalOverlay issueDetailOverlay"
          role="dialog"
          aria-modal="true"
          aria-label="Issue 详情"
          onClick={closeDetail}
        >
          <div className="issueDetailDrawer" onClick={(e) => e.stopPropagation()}>
            <Outlet context={outletContext} />
          </div>
        </div>
      ) : null}

      {actionIssue ? (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Issue 操作" onClick={closeIssueActions}>
          <div className="modalPanel card" onClick={(e) => e.stopPropagation()}>
            <div className="row spaceBetween">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800 }}>Issue 操作</div>
                <div
                  className="muted"
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={actionIssue.title}
                >
                  {actionIssue.title}
                </div>
              </div>
              <button type="button" className="buttonSecondary" onClick={closeIssueActions}>
                关闭
              </button>
            </div>

            <div className="row gap" style={{ marginTop: 10 }}>
              <StatusBadge status={actionIssue.status} />
              {actionIssue.runs?.[0] ? <StatusBadge status={actionIssue.runs[0].status} /> : <span className="muted">-</span>}
            </div>

            {!auth.user ? (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ marginBottom: 10 }}>
                  登录后可执行状态变更/启动 Run 等操作。
                </div>
                <button
                  type="button"
                  onClick={() => {
                    closeIssueActions();
                    navigate(`/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
                  }}
                >
                  去登录
                </button>
              </div>
            ) : issueActions.primary.length || issueActions.statuses.length ? (
              <>
                {issueActions.primary.length ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="muted">运行</div>
                    <div className="actionGrid">
                      {issueActions.primary.map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          className={a.variant === "danger" ? "buttonDanger" : undefined}
                          onClick={() => void runIssueAction(a.toStatus)}
                          disabled={moving || (actionIssue.status === "running" && !actionIssueRunId)}
                          title={actionIssue.status === "running" && !actionIssueRunId ? "缺少 runId，无法操作" : undefined}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {issueActions.statuses.length ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="muted">状态</div>
                    <div className="actionGrid">
                      {issueActions.statuses.map((a) => (
                        <button
                          key={a.key}
                          type="button"
                          className="buttonSecondary"
                          onClick={() => void runIssueAction(a.toStatus)}
                          disabled={moving || a.disabled}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="muted" style={{ marginTop: 12 }}>
                当前账号暂无可用操作。
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
