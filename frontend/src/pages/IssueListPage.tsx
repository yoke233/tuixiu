import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, Outlet, useParams } from "react-router-dom";

import { createIssue, listIssues, startIssue, updateIssue } from "../api/issues";
import { createProject, listProjects } from "../api/projects";
import { cancelRun, completeRun } from "../api/runs";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Issue, IssueStatus, Project } from "../types";

function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function IssueListPage() {
  const params = useParams();
  const selectedIssueId = params.id ?? "";
  const hasDetail = !!selectedIssueId;

  const splitRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{ active: boolean; width: number }>({ active: false, width: 520 });

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

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [projectScmType, setProjectScmType] = useState("gitlab");
  const [projectDefaultBranch, setProjectDefaultBranch] = useState("main");
  const [projectGitlabProjectId, setProjectGitlabProjectId] = useState("");
  const [projectGitlabAccessToken, setProjectGitlabAccessToken] = useState("");
  const [projectGitlabWebhookSecret, setProjectGitlabWebhookSecret] = useState("");
  const [projectGithubAccessToken, setProjectGithubAccessToken] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueCriteria, setIssueCriteria] = useState("");
  const [searchText, setSearchText] = useState("");
  const [detailWidth, setDetailWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("detailWidth");
      const parsed = raw ? Number(raw) : 520;
      return Number.isFinite(parsed) ? parsed : 520;
    } catch {
      return 520;
    }
  });

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

  const visibleIssues = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    const filtered = issues.filter((i) => i.projectId === effectiveProjectId);
    if (!needle) return filtered;
    return filtered.filter((i) => {
      const t = `${i.title ?? ""}\n${i.description ?? ""}`.toLowerCase();
      return t.includes(needle);
    });
  }, [effectiveProjectId, issues, searchText]);

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

  useEffect(() => {
    resizeStateRef.current.width = detailWidth;
    try {
      localStorage.setItem("detailWidth", String(detailWidth));
    } catch {
      // ignore
    }
  }, [detailWidth]);

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const gitlabProjectIdRaw = projectGitlabProjectId.trim();
      const gitlabProjectId = gitlabProjectIdRaw ? Number(gitlabProjectIdRaw) : undefined;

      const p = await createProject({
        name: projectName.trim(),
        repoUrl: projectRepoUrl.trim(),
        scmType: projectScmType.trim() || undefined,
        defaultBranch: projectDefaultBranch.trim() || undefined,
        gitlabProjectId: Number.isFinite(gitlabProjectId ?? NaN) ? gitlabProjectId : undefined,
        gitlabAccessToken: projectGitlabAccessToken.trim() || undefined,
        gitlabWebhookSecret: projectGitlabWebhookSecret.trim() || undefined,
        githubAccessToken: projectGithubAccessToken.trim() || undefined
      });
      setProjectName("");
      setProjectRepoUrl("");
      setProjectScmType("gitlab");
      setProjectDefaultBranch("main");
      setProjectGitlabProjectId("");
      setProjectGitlabAccessToken("");
      setProjectGitlabWebhookSecret("");
      setProjectGithubAccessToken("");
      await refresh();
      setSelectedProjectId(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateIssue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      if (!issueTitle.trim()) {
        setError("Issue 标题不能为空");
        return;
      }
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }

      await createIssue({
        projectId: effectiveProjectId,
        title: issueTitle.trim(),
        description: issueDescription.trim() ? issueDescription.trim() : undefined,
        acceptanceCriteria: splitLines(issueCriteria),
      });

      setIssueTitle("");
      setIssueDescription("");
      setIssueCriteria("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const splitStyle = useMemo(() => {
    const clamped = Math.max(360, Math.min(960, detailWidth));
    const style: CSSProperties = {
      ["--detail-width" as any]: `${clamped}px`
    };
    return style;
  }, [detailWidth]);

  function onSplitterPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const container = splitRef.current;
    if (!container) return;

    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    resizeStateRef.current.active = true;
    container.classList.add("resizing");
    document.body.style.userSelect = "none";
  }

  function onSplitterPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStateRef.current.active) return;
    const container = splitRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const raw = rect.right - e.clientX;
    const max = Math.min(960, Math.max(360, rect.width - 360));
    const next = Math.max(360, Math.min(max, Math.round(raw)));
    setDetailWidth(next);
  }

  function onSplitterPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!resizeStateRef.current.active) return;
    resizeStateRef.current.active = false;
    splitRef.current?.classList.remove("resizing");
    document.body.style.userSelect = "";
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
  }

  function onSplitterDoubleClick() {
    setDetailWidth(520);
  }

  function onSplitterKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 20;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setDetailWidth((w) => Math.max(360, w + step));
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setDetailWidth((w) => Math.max(360, w - step));
    }
  }

  return (
    <div className="issuesShell">
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
          <button onClick={() => refresh()} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <div ref={splitRef} className={`issuesSplit ${hasDetail ? "hasDetail" : ""}`} style={splitStyle}>
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

            <details className="boardTools">
              <summary>创建 / 配置</summary>
              <div className="grid2">
                <section className="card">
                  <h3>Projects</h3>
                  {loading ? (
                    <div className="muted">加载中…</div>
                  ) : projects.length ? (
                    <div className="muted">当前共 {projects.length} 个</div>
                  ) : (
                    <div className="muted">暂无 Project，请先创建</div>
                  )}

                  <form onSubmit={onCreateProject} className="form">
                    <label className="label">
                      名称
                      <input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
                    </label>
                    <label className="label">
                      Repo URL
                      <input value={projectRepoUrl} onChange={(e) => setProjectRepoUrl(e.target.value)} />
                    </label>
                    <label className="label">
                      SCM
                      <select value={projectScmType} onChange={(e) => setProjectScmType(e.target.value)}>
                        <option value="gitlab">gitlab</option>
                        <option value="github">github</option>
                        <option value="gitee">gitee</option>
                      </select>
                    </label>
                    <label className="label">
                      默认分支
                      <input value={projectDefaultBranch} onChange={(e) => setProjectDefaultBranch(e.target.value)} />
                    </label>
                    {projectScmType === "gitlab" ? (
                      <details>
                        <summary>GitLab 配置（可选）</summary>
                        <label className="label">
                          GitLab Project ID
                          <input
                            value={projectGitlabProjectId}
                            onChange={(e) => setProjectGitlabProjectId(e.target.value)}
                            placeholder="12345"
                          />
                        </label>
                        <label className="label">
                          GitLab Access Token
                          <input
                            type="password"
                            value={projectGitlabAccessToken}
                            onChange={(e) => setProjectGitlabAccessToken(e.target.value)}
                            placeholder="glpat-..."
                          />
                        </label>
                        <label className="label">
                          GitLab Webhook Secret（可选）
                          <input
                            type="password"
                            value={projectGitlabWebhookSecret}
                            onChange={(e) => setProjectGitlabWebhookSecret(e.target.value)}
                          />
                        </label>
                      </details>
                    ) : projectScmType === "github" ? (
                      <details>
                        <summary>GitHub 配置（可选）</summary>
                        <label className="label">
                          GitHub Access Token
                          <input
                            type="password"
                            value={projectGithubAccessToken}
                            onChange={(e) => setProjectGithubAccessToken(e.target.value)}
                            placeholder="ghp_... / github_pat_..."
                          />
                        </label>
                      </details>
                    ) : null}
                    <button type="submit" disabled={!projectName.trim() || !projectRepoUrl.trim()}>
                      创建
                    </button>
                  </form>
                </section>

                <section className="card">
                  <h3>创建 Issue（进入需求池）</h3>
                  <form onSubmit={onCreateIssue} className="form">
                    <label className="label">
                      标题 *
                      <input
                        aria-label="Issue 标题"
                        value={issueTitle}
                        onChange={(e) => setIssueTitle(e.target.value)}
                      />
                    </label>
                    <label className="label">
                      描述
                      <textarea
                        value={issueDescription}
                        onChange={(e) => setIssueDescription(e.target.value)}
                      />
                    </label>
                    <label className="label">
                      验收标准（每行一条）
                      <textarea value={issueCriteria} onChange={(e) => setIssueCriteria(e.target.value)} />
                    </label>
                    <button type="submit">提交</button>
                  </form>
                </section>
              </div>
            </details>
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
                          <Link
                            key={i.id}
                            to={`/issues/${i.id}`}
                            draggable
                            onDragStart={(e) => {
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
                            <div className="row spaceBetween">
                              <div className="issueTitle">{i.title}</div>
                              <StatusBadge status={i.status} />
                            </div>
                            <div className="row spaceBetween issueMeta">
                              <div className="muted">{new Date(i.createdAt).toLocaleDateString()}</div>
                              {latestRun ? <StatusBadge status={latestRun.status} /> : <span className="muted">-</span>}
                            </div>
                          </Link>
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

        {hasDetail ? (
          <>
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整详情宽度"
              tabIndex={0}
              onPointerDown={onSplitterPointerDown}
              onPointerMove={onSplitterPointerMove}
              onPointerUp={onSplitterPointerUp}
              onPointerCancel={onSplitterPointerUp}
              onDoubleClick={onSplitterDoubleClick}
              onKeyDown={onSplitterKeyDown}
            />

            <aside className="issuesDetail" aria-label="Issue 详情面板">
              <Outlet context={outletContext} />
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
