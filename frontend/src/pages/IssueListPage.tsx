import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { createIssue, listIssues } from "../api/issues";
import { createProject, listProjects } from "../api/projects";
import { StatusBadge } from "../components/StatusBadge";
import type { Issue, Project } from "../types";

function splitLines(s: string): string[] {
  return s
    .split(/\r?\n/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function IssueListPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("");
  const [projectRepoUrl, setProjectRepoUrl] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueCriteria, setIssueCriteria] = useState("");

  const effectiveProjectId = useMemo(() => {
    if (selectedProjectId) return selectedProjectId;
    return projects[0]?.id ?? "";
  }, [projects, selectedProjectId]);

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

  async function onCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const p = await createProject({ name: projectName, repoUrl: projectRepoUrl });
      setProjectName("");
      setProjectRepoUrl("");
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

  return (
    <div className="container">
      <div className="header">
        <h1>ACP 协作台</h1>
        <div className="muted">Project / Issue / Run / Events</div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <div className="grid2">
        <section className="card">
          <h2>Projects</h2>
          {loading ? (
            <div className="muted">加载中…</div>
          ) : projects.length ? (
            <>
              <label className="label">
                选择 Project
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
              </label>
              <div className="muted">当前共 {projects.length} 个</div>
            </>
          ) : (
            <div className="muted">暂无 Project，请先创建</div>
          )}

          <form onSubmit={onCreateProject} className="form">
            <h3>创建 Project</h3>
            <label className="label">
              名称
              <input value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            </label>
            <label className="label">
              Repo URL
              <input value={projectRepoUrl} onChange={(e) => setProjectRepoUrl(e.target.value)} />
            </label>
            <button type="submit" disabled={!projectName.trim() || !projectRepoUrl.trim()}>
              创建
            </button>
          </form>
        </section>

        <section className="card">
          <h2>创建 Issue</h2>
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
              <textarea value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} />
            </label>
            <label className="label">
              验收标准（每行一条）
              <textarea value={issueCriteria} onChange={(e) => setIssueCriteria(e.target.value)} />
            </label>
            <button type="submit">提交</button>
          </form>
        </section>
      </div>

      <section className="card">
        <div className="row spaceBetween">
          <h2>Issues</h2>
          <button onClick={() => refresh()} disabled={loading}>
            刷新
          </button>
        </div>

        {loading ? (
          <div className="muted">加载中…</div>
        ) : issues.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>最新 Run</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => {
                const latestRun = i.runs?.[0];
                return (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/issues/${i.id}`}>{i.title}</Link>
                    </td>
                    <td>
                      <StatusBadge status={i.status} />
                    </td>
                    <td>{latestRun ? <StatusBadge status={latestRun.status} /> : <span className="muted">-</span>}</td>
                    <td className="muted">{new Date(i.createdAt).toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="muted">暂无 Issue</div>
        )}
      </section>
    </div>
  );
}

