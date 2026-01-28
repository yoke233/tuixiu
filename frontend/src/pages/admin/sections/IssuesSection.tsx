import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { importGitHubIssue } from "../../../api/githubIssues";
import { createIssue } from "../../../api/issues";
import type { Project } from "../../../types";
import { splitLines } from "../adminUtils";

type Props = {
  active: boolean;
  effectiveProject: Project | null;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
  onRefreshGlobal: () => Promise<void>;
};

export function IssuesSection(props: Props) {
  const { active, effectiveProject, effectiveProjectId, requireAdmin, setError, onRefreshGlobal } = props;
  const location = useLocation();

  const [issueTitle, setIssueTitle] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [issueCriteria, setIssueCriteria] = useState("");

  const [githubImport, setGithubImport] = useState("");
  const [importingGithub, setImportingGithub] = useState(false);

  useEffect(() => {
    if (!active) return;
    const hash = location.hash || "";
    const id = hash.startsWith("#") ? hash.slice(1) : "";
    if (!id) return;

    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 0);
    return () => clearTimeout(t);
  }, [active, location.hash]);

  async function onCreateIssue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
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
      await onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onImportGithubIssue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId) {
      setError("请先创建 Project");
      return;
    }
    const raw = githubImport.trim();
    if (!raw) return;

    setImportingGithub(true);
    try {
      const num = Number(raw);
      const input = Number.isFinite(num) && num > 0 ? { number: Math.floor(num) } : { url: raw };
      await importGitHubIssue(effectiveProjectId, input);
      setGithubImport("");
      await onRefreshGlobal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingGithub(false);
    }
  }

  return (
    <>
      <section id="issue-github-import" className="card" style={{ gridColumn: "1 / -1" }} hidden={!active}>
        <h2 style={{ marginTop: 0 }}>导入 GitHub Issue</h2>
        {effectiveProject?.scmType?.toLowerCase() === "github" ? (
          <form onSubmit={(e) => void onImportGithubIssue(e)} className="form">
            <label className="label">
              Issue Number 或 URL
              <input
                value={githubImport}
                onChange={(e) => setGithubImport(e.target.value)}
                placeholder="123 或 https://github.com/o/r/issues/123"
              />
            </label>
            <button type="submit" disabled={!githubImport.trim() || importingGithub || !effectiveProjectId}>
              {importingGithub ? "导入中…" : "导入"}
            </button>
          </form>
        ) : (
          <div className="muted">当前 Project 不是 GitHub SCM</div>
        )}
      </section>

      <section id="issue-create" className="card" style={{ gridColumn: "1 / -1" }} hidden={!active}>
        <h2 style={{ marginTop: 0 }}>创建 Issue（进入需求池）</h2>
        <form onSubmit={(e) => void onCreateIssue(e)} className="form">
          <label className="label">
            标题 *
            <input aria-label="Issue 标题" value={issueTitle} onChange={(e) => setIssueTitle(e.target.value)} />
          </label>
          <label className="label">
            描述
            <textarea value={issueDescription} onChange={(e) => setIssueDescription(e.target.value)} />
          </label>
          <label className="label">
            验收标准（每行一条）
            <textarea value={issueCriteria} onChange={(e) => setIssueCriteria(e.target.value)} />
          </label>
          <button type="submit" disabled={!effectiveProjectId}>
            提交
          </button>
        </form>
        {!effectiveProjectId ? <div className="muted">请先创建 Project</div> : null}
      </section>
    </>
  );
}

