import { useEffect, useMemo, useState } from "react";

import { createRunMr, getRun, getRunChanges, getRunDiff, mergeRunMr, type RunChanges } from "../api/runs";
import type { Project, Run } from "../types";

type Props = {
  runId: string;
  project?: Project;
  run?: Run | null;
  onRunUpdated?: (run: Run) => void;
  onAfterAction?: () => void;
};

function normalizeRepoWebUrl(repoUrl: string): string | null {
  const raw = repoUrl.trim();
  if (!raw) return null;

  // https://host/org/repo(.git)
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      u.hash = "";
      u.search = "";
      u.pathname = u.pathname.replace(/\.git$/i, "");
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }

  // git@host:org/repo(.git)
  const m = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
  if (m) {
    const host = m[1];
    const path = m[2].replace(/\.git$/i, "");
    return `https://${host}/${path}`.replace(/\/+$/, "");
  }

  return null;
}

function buildCreatePrUrl(opts: { project?: Project; baseBranch: string; branch: string }): string | null {
  const web = opts.project?.repoUrl ? normalizeRepoWebUrl(opts.project.repoUrl) : null;
  if (!web) return null;

  const scm = (opts.project?.scmType || "gitlab").toLowerCase();
  const base = encodeURIComponent(opts.baseBranch);
  const head = encodeURIComponent(opts.branch);

  if (scm === "github") {
    return `${web}/compare/${base}...${head}?expand=1`;
  }
  if (scm === "gitlab") {
    const qs = new URLSearchParams({
      "merge_request[source_branch]": opts.branch,
      "merge_request[target_branch]": opts.baseBranch,
    });
    return `${web}/-/merge_requests/new?${qs.toString()}`;
  }

  // gitee / unknown：先回退到仓库链接
  return web;
}

export function RunChangesPanel(props: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [mrLoading, setMrLoading] = useState(false);

  const mrArtifact = useMemo(() => {
    const arts = props.run?.artifacts ?? [];
    return arts.find((a) => a.type === "mr") ?? null;
  }, [props.run]);

  const mrInfo = useMemo(() => {
    if (!mrArtifact) return null;
    const c = mrArtifact.content as any;
    const webUrl = (typeof c?.webUrl === "string" && c.webUrl) || (typeof c?.web_url === "string" && c.web_url) || "";
    const state = (typeof c?.state === "string" && c.state) || "";
    const idNumRaw = typeof c?.iid === "number" ? c.iid : typeof c?.number === "number" ? c.number : Number(c?.iid ?? c?.number);
    return { webUrl, state, num: Number.isFinite(idNumRaw) ? idNumRaw : null };
  }, [mrArtifact]);

  const provider = useMemo(() => (props.project?.scmType ?? "").toLowerCase(), [props.project]);
  const providerLabel = provider === "github" ? "PR" : "MR";
  const canUseApi = provider === "gitlab" || provider === "github";

  async function refreshRun() {
    if (!props.runId) return;
    try {
      const r = await getRun(props.runId);
      props.onRunUpdated?.(r);
    } catch {
      // ignore
    }
  }

  async function refresh() {
    if (!props.runId) return;
    setLoading(true);
    setError(null);
    try {
      const c = await getRunChanges(props.runId);
      setChanges(c);
      if (!selectedPath && c.files[0]?.path) setSelectedPath(c.files[0].path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setChanges(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSelectedPath("");
    setDiff("");
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runId]);

  useEffect(() => {
    const runId = props.runId;
    if (!runId || !selectedPath) return;
    setDiffLoading(true);
    setError(null);
    getRunDiff(runId, selectedPath)
      .then((r) => setDiff(r.diff || ""))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDiffLoading(false));
  }, [props.runId, selectedPath]);

  const createPrUrl = useMemo(() => {
    if (!changes) return null;
    return buildCreatePrUrl({ project: props.project, baseBranch: changes.baseBranch, branch: changes.branch });
  }, [changes, props.project]);

  async function onCreateMr() {
    if (!props.runId) return;
    setMrLoading(true);
    setError(null);
    try {
      await createRunMr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMrLoading(false);
    }
  }

  async function onMergeMr() {
    if (!props.runId) return;
    setMrLoading(true);
    setError(null);
    try {
      await mergeRunMr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMrLoading(false);
    }
  }

  if (!props.runId) {
    return (
      <section className="card">
        <h2>变更</h2>
        <div className="muted">暂无 Run</div>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="row spaceBetween">
        <h2>变更</h2>
        <div className="row gap">
          <button onClick={refresh} disabled={loading}>
            刷新
          </button>
          {canUseApi ? (
            mrInfo ? (
              <>
                <a className="buttonSecondary" href={mrInfo.webUrl || "#"} target="_blank" rel="noreferrer">
                  打开 {providerLabel}
                  {mrInfo.num ? ` #${mrInfo.num}` : ""}
                </a>
                <button onClick={onMergeMr} disabled={mrLoading}>
                  合并 {providerLabel}
                </button>
              </>
            ) : (
              <button onClick={onCreateMr} disabled={mrLoading}>
                创建 {providerLabel}
              </button>
            )
          ) : createPrUrl ? (
            <a className="buttonSecondary" href={createPrUrl} target="_blank" rel="noreferrer">
              打开 MR/PR 页面
            </a>
          ) : null}
        </div>
      </div>

      {mrInfo ? (
        <div className="muted" style={{ marginTop: 6 }}>
          {providerLabel} 状态：{mrInfo.state || "未知"}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="alert" style={{ marginTop: 10 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="muted">加载变更中…</div>
      ) : changes ? (
        <>
          <div className="muted" style={{ marginBottom: 10 }}>
            {changes.baseBranch} → {changes.branch} · {changes.files.length} files
          </div>

          <div className="changesGrid">
            <div className="changesFiles" role="list" aria-label="变更文件列表">
              {changes.files.length ? (
                changes.files.map((f) => {
                  const active = selectedPath === f.path;
                  return (
                    <button
                      key={`${f.status}:${f.oldPath ?? ""}:${f.path}`}
                      type="button"
                      className={`fileRow ${active ? "active" : ""}`}
                      onClick={() => setSelectedPath(f.path)}
                    >
                      <code className="fileStatus">{f.status}</code>
                      <span className="filePath" title={f.path}>
                        {f.path}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="muted">暂无变更</div>
              )}
            </div>

            <div className="changesDiff" aria-label="Diff">
              {diffLoading ? (
                <div className="muted">加载 diff…</div>
              ) : diff ? (
                <pre className="pre">{diff}</pre>
              ) : (
                <div className="muted">请选择文件</div>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="muted">暂无变更信息（需要 branch 产物或已推送分支）</div>
      )}
    </section>
  );
}
