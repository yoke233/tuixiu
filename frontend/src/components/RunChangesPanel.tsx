import { useEffect, useMemo, useState } from "react";

import {
  createRunPr,
  getRun,
  getRunChanges,
  getRunDiff,
  mergeRunPr,
  promptRun,
  syncRunPr,
  type RunChanges,
} from "../api/runs";
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
  const [prLoading, setPrLoading] = useState(false);

  const prArtifact = useMemo(() => {
    const arts = props.run?.artifacts ?? [];
    return arts.find((a) => a.type === "pr") ?? null;
  }, [props.run]);

  const prInfo = useMemo(() => {
    if (!prArtifact) return null;
    const c = prArtifact.content as any;
    const webUrl = (typeof c?.webUrl === "string" && c.webUrl) || (typeof c?.web_url === "string" && c.web_url) || "";
    const state = (typeof c?.state === "string" && c.state) || "";
    const mergeable = typeof c?.mergeable === "boolean" ? c.mergeable : null;
    const mergeableState = (typeof c?.mergeable_state === "string" && c.mergeable_state) || "";
    const sourceBranch =
      (typeof c?.sourceBranch === "string" && c.sourceBranch) || (typeof c?.source_branch === "string" && c.source_branch) || "";
    const targetBranch =
      (typeof c?.targetBranch === "string" && c.targetBranch) || (typeof c?.target_branch === "string" && c.target_branch) || "";
    const idNumRaw = typeof c?.iid === "number" ? c.iid : typeof c?.number === "number" ? c.number : Number(c?.iid ?? c?.number);
    return {
      webUrl,
      state,
      mergeable,
      mergeableState,
      sourceBranch,
      targetBranch,
      num: Number.isFinite(idNumRaw) ? idNumRaw : null,
    };
  }, [prArtifact]);

  const provider = useMemo(() => (props.project?.scmType ?? "").toLowerCase(), [props.project]);
  const providerLabel = "PR";
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

  async function onCreatePr() {
    if (!props.runId) return;
    setPrLoading(true);
    setError(null);
    try {
      await createRunPr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }

  async function onMergePr() {
    if (!props.runId) return;
    setPrLoading(true);
    setError(null);
    try {
      const synced = await syncRunPr(props.runId);
      const c = synced.content as any;
      const mergeable = typeof c?.mergeable === "boolean" ? c.mergeable : null;
      const mergeableState = typeof c?.mergeable_state === "string" ? c.mergeable_state : "";
      if (mergeableState === "dirty") {
        setError("GitHub 显示该 PR 存在合并冲突（mergeable_state=dirty），请先解决冲突再合并。");
        await refreshRun();
        return;
      }
      if (mergeable === false) {
        const detail = mergeableState ? `（mergeable_state=${mergeableState}）` : "";
        setError(`该 PR 当前不可合并${detail}，请先同步/修复阻塞项后再重试。`);
        await refreshRun();
        return;
      }

      await mergeRunPr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }

  async function onSyncPr() {
    if (!props.runId) return;
    setPrLoading(true);
    setError(null);
    try {
      await syncRunPr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }

  async function onAskAgentToFixMerge() {
    if (!props.runId) return;
    setPrLoading(true);
    setError(null);
    try {
      const run = props.run ?? (await getRun(props.runId));
      const base = prInfo?.targetBranch || changes?.baseBranch || props.project?.defaultBranch || "main";
      const head = prInfo?.sourceBranch || changes?.branch || run.branchName || "";
      const workspace = run.workspacePath || "";
      const url = prInfo?.webUrl || "";

      const title = prInfo?.mergeableState === "dirty" ? "解决合并冲突" : "更新分支以便可合并";
      const hint =
        prInfo?.mergeableState === "dirty"
          ? "GitHub 标记为 mergeable_state=dirty（有冲突）。"
          : prInfo?.mergeableState
            ? `GitHub mergeable_state=${prInfo.mergeableState}。`
            : "GitHub mergeable 状态未知。";

      const lines = [
        `请帮我${title}并推送到远端分支，然后回复“已推送”。`,
        url ? `PR: ${url}` : "",
        head ? `分支: ${head}` : "",
        base ? `目标分支: ${base}` : "",
        workspace ? `工作区: ${workspace}` : "",
        "",
        hint,
        "",
        "建议步骤（在当前 worktree 执行）：",
        "1) git fetch origin",
        `2) git merge origin/${base}`,
        "3) 解决冲突后：git add -A",
        "4) git commit -m \"chore: resolve merge conflicts\"",
        "5) git push",
        "",
        "要求：不引入无关改动；确保 tests/lint 通过（如项目有）。",
      ].filter(Boolean);

      await promptRun(props.runId, lines.join("\n"));
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
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
            prInfo ? (
              <>
                <a className="buttonSecondary" href={prInfo.webUrl || "#"} target="_blank" rel="noreferrer">
                  打开 {providerLabel}
                  {prInfo.num ? ` #${prInfo.num}` : ""}
                </a>
                <button onClick={onSyncPr} disabled={prLoading}>
                  同步 {providerLabel} 状态
                </button>
                {prInfo.mergeableState === "dirty" || prInfo.mergeableState === "behind" ? (
                  <button onClick={onAskAgentToFixMerge} disabled={prLoading}>
                    让 Agent {prInfo.mergeableState === "dirty" ? "解决冲突" : "更新分支"}
                  </button>
                ) : null}
                <button
                  onClick={onMergePr}
                  disabled={prLoading || prInfo.mergeableState === "dirty" || prInfo.mergeable === false}
                >
                  合并 {providerLabel}
                </button>
              </>
            ) : (
              <button onClick={onCreatePr} disabled={prLoading}>
                创建 {providerLabel}
              </button>
            )
          ) : createPrUrl ? (
            <a className="buttonSecondary" href={createPrUrl} target="_blank" rel="noreferrer">
              打开 PR 页面
            </a>
          ) : null}
        </div>
      </div>

      {prInfo ? (
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
