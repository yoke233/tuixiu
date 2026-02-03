import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { approveApproval, rejectApproval } from "../../api/approvals";
import { autoReviewRun } from "../../api/pm";
import {
  createRunPr,
  getRun,
  getRunChanges,
  getRunDiff,
  promptRun,
  requestMergeRunPr,
  syncRunPr,
  type RunChanges,
} from "../../api/runs";
import { useAuth } from "../../auth/AuthContext";
import type { Project, Run } from "../../types";

import { buildCreatePrUrl } from "./utils";

type Props = {
  runId: string;
  project?: Project;
  run?: Run | null;
  onRunUpdated?: (run: Run) => void;
  onAfterAction?: () => void;
};

export type RunChangesController = ReturnType<typeof useRunChangesController>;

export function useRunChangesController(props: Props) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<RunChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState<string>("");
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [prLoading, setPrLoading] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);

  const prArtifact = useMemo(() => {
    const arts = props.run?.artifacts ?? [];
    return arts.find((a) => a.type === "pr") ?? null;
  }, [props.run]);

  const mergeApproval = useMemo(() => {
    const arts = props.run?.artifacts ?? [];
    const reports = arts.filter((a) => a.type === "report");
    const sorted = [...reports].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    for (const art of sorted) {
      const content = art.content as any;
      if (!content || typeof content !== "object") continue;
      if (content.kind !== "approval_request") continue;
      if (content.action !== "merge_pr") continue;
      return { artifact: art, content };
    }
    return null;
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
  const canUseApi =
    (provider === "github" && Boolean(props.project?.hasScmAdminCredential)) ||
    ((provider === "gitlab" || provider === "codeup") &&
      Boolean(props.project?.gitlabProjectId) &&
      Boolean(props.project?.hasScmAdminCredential));

  const requireLogin = useCallback((): boolean => {
    if (auth.user) return true;
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    navigate(`/login?next=${next}`);
    return false;
  }, [auth.user, location.pathname, location.search, navigate]);

  const refreshSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      refreshSeqRef.current += 1;
    };
  }, []);

  const refreshRun = useCallback(async () => {
    if (!props.runId) return;
    try {
      const r = await getRun(props.runId);
      props.onRunUpdated?.(r);
    } catch {
      // ignore
    }
  }, [props]);

  const refresh = useCallback(async () => {
    if (!props.runId) return;
    const seq = (refreshSeqRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const c = await getRunChanges(props.runId);
      if (refreshSeqRef.current !== seq) return;
      setChanges(c);
      setSelectedPath((prev) => (prev ? prev : c.files[0]?.path ?? ""));
    } catch (e) {
      if (refreshSeqRef.current !== seq) return;
      setError(e instanceof Error ? e.message : String(e));
      setChanges(null);
    } finally {
      if (refreshSeqRef.current === seq) {
        setLoading(false);
      }
    }
  }, [props.runId]);

  useEffect(() => {
    if (auth.status === "loading") return;
    setSelectedPath("");
    setDiff("");
    void refresh();
  }, [auth.status, refresh]);

  useEffect(() => {
    const runId = props.runId;
    if (!runId || !selectedPath) return;
    let cancelled = false;
    setDiffLoading(true);
    setError(null);
    getRunDiff(runId, selectedPath)
      .then((r) => {
        if (cancelled) return;
        setDiff(r.diff || "");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.runId, selectedPath]);

  const createPrUrl = useMemo(() => {
    if (!changes) return null;
    return buildCreatePrUrl({ project: props.project, baseBranch: changes.baseBranch, branch: changes.branch });
  }, [changes, props.project]);

  const onCreatePr = useCallback(async () => {
    if (!props.runId) return;
    if (!requireLogin()) return;
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
  }, [props, refreshRun, requireLogin]);

  const onAutoReview = useCallback(async () => {
    if (!props.runId) return;
    if (!requireLogin()) return;
    setReviewLoading(true);
    setError(null);
    try {
      await autoReviewRun(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewLoading(false);
    }
  }, [props, refreshRun, requireLogin]);

  const onMergePr = useCallback(async () => {
    if (!props.runId) return;
    if (!requireLogin()) return;
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

      await requestMergeRunPr(props.runId);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }, [props, refreshRun, requireLogin]);

  const onApproveMerge = useCallback(async () => {
    if (!mergeApproval?.artifact?.id) return;
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

      await approveApproval(mergeApproval.artifact.id);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }, [mergeApproval?.artifact?.id, props, refreshRun]);

  const onRejectMerge = useCallback(async () => {
    if (!mergeApproval?.artifact?.id) return;
    setPrLoading(true);
    setError(null);
    try {
      await rejectApproval(mergeApproval.artifact.id);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }, [mergeApproval?.artifact?.id, props, refreshRun]);

  const onSyncPr = useCallback(async () => {
    if (!props.runId) return;
    if (!requireLogin()) return;
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
  }, [props, refreshRun, requireLogin]);

  const onAskAgentToFixMerge = useCallback(async () => {
    if (!props.runId) return;
    if (!requireLogin()) return;
    setPrLoading(true);
    setError(null);
    try {
      const run = props.run ?? (await getRun(props.runId));
      if (run.executorType !== "agent") {
        setError("当前 Run 不是 Agent 执行器，无法发送 prompt");
        return;
      }
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
        "3) 解决冲突",
        "4) 确保 tests/lint 通过（如项目有）",
        "5) 提交修复说明",
        "6) git push",
        "",
        "要求：不引入无关改动。",
      ].filter(Boolean);

      await promptRun(props.runId, [{ type: "text", text: lines.join("\n") }]);
      await refreshRun();
      props.onAfterAction?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrLoading(false);
    }
  }, [changes?.baseBranch, changes?.branch, prInfo, props, refreshRun, requireLogin]);

  return {
    // props
    runId: props.runId,
    project: props.project,
    run: props.run,

    // state
    loading,
    error,
    changes,
    selectedPath,
    setSelectedPath,
    diff,
    diffLoading,
    prLoading,
    reviewLoading,

    // derived
    prInfo,
    mergeApproval,
    providerLabel,
    canUseApi,
    createPrUrl,

    // actions
    refresh,
    onAutoReview,
    onCreatePr,
    onSyncPr,
    onAskAgentToFixMerge,
    onMergePr,
    onApproveMerge,
    onRejectMerge,
    setError,
  } as const;
}
