import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import { listIssues, startIssue, updateIssue } from "@/api/issues";
import { listProjects } from "@/api/projects";
import { cancelRun, completeRun } from "@/api/runs";
import { useAuth } from "@/auth/AuthContext";
import type { Issue, IssueStatus, Project } from "@/types";
import { canChangeIssueStatus, canRunIssue } from "@/utils/permissions";
import { getLastSelectedProjectId, getShowArchivedIssues, setLastSelectedProjectId } from "@/utils/settings";
import type { IssuesOutletContext } from "@/pages/issueDetail/types";

import { hasStringLabel } from "@/pages/issues/issueListUtils";
import type { DragPayload, IssueBoardColumn } from "@/pages/issues/types";

export type IssueListController = ReturnType<typeof useIssueListController>;

function getIssuesByStatus(issues: Issue[]): Record<IssueStatus, Issue[]> {
  const map: Record<IssueStatus, Issue[]> = {
    pending: [],
    running: [],
    reviewing: [],
    done: [],
    failed: [],
    cancelled: [],
  };
  for (const i of issues) {
    map[i.status]?.push(i);
  }
  for (const key of Object.keys(map) as IssueStatus[]) {
    map[key].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return map;
}

export function useIssueListController() {
  const params = useParams();
  const selectedIssueId = params.id ?? "";
  const hasDetail = !!selectedIssueId;
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const userRole = auth.user?.role ?? null;
  const canRun = canRunIssue(userRole);
  const canChangeStatus = canChangeIssueStatus(userRole);

  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [dropStatus, setDropStatus] = useState<IssueStatus | null>(null);
  const [moving, setMoving] = useState(false);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 720px)").matches
      : false,
  );

  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback(() => setError(null), []);

  const onIssueUpdated = useCallback((issue: Issue) => {
    setIssues((prev) => {
      const idx = prev.findIndex((x) => x.id === issue.id);
      if (idx === -1) return [issue, ...prev];
      const next = [...prev];
      next[idx] = issue;
      return next;
    });
  }, []);

  const outletContext = useMemo<IssuesOutletContext>(() => ({ onIssueUpdated }), [onIssueUpdated]);

  const [selectedProjectId, setSelectedProjectIdState] = useState<string>(() =>
    getLastSelectedProjectId(),
  );
  const selectedProjectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  const setSelectedProjectId = useCallback((next: string) => {
    selectedProjectIdRef.current = next;
    setSelectedProjectIdState(next);
    setLastSelectedProjectId(next);
  }, []);
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
        !hasStringLabel(i.labels, "_session"),
    );
    if (!needle) return filtered;
    return filtered.filter((i) => {
      const t = `${i.title ?? ""}\n${i.description ?? ""}`.toLowerCase();
      return t.includes(needle);
    });
  }, [effectiveProjectId, issues, searchText, showArchivedOnBoard]);

  const issuesByStatus = useMemo(() => getIssuesByStatus(visibleIssues), [visibleIssues]);

  useEffect(() => {
    if (!hasDetail) return;
    if (isMobile) return;

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
  }, [closeDetail, hasDetail, isMobile]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(max-width: 720px)");
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };
    setIsMobile(media.matches);
    if (media.addEventListener) {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ps, is] = await Promise.all([listProjects(), listIssues()]);
      setProjects(ps);
      setIssues(is.issues);
      const stored = getLastSelectedProjectId();
      const preferred = selectedProjectIdRef.current || stored;
      const next =
        preferred && ps.some((p) => p.id === preferred) ? preferred : (ps[0]?.id ?? "");
      setSelectedProjectId(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setSelectedProjectId]);

  useEffect(() => {
    if (auth.status === "loading") return;
    void refresh();
  }, [auth.status, refresh]);

  const readDragPayload = useCallback((e: React.DragEvent): DragPayload | null => {
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
  }, []);

  const moveIssue = useCallback(
    async (payload: DragPayload, toStatus: IssueStatus) => {
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
    },
    [auth.user, canChangeStatus, canRun, location.pathname, location.search, navigate, refresh],
  );

  const columns = useMemo(
    () =>
      [
        { key: "pending", title: "To Do", dot: "dotGray" },
        { key: "running", title: "In Progress", dot: "dotBlue" },
        { key: "reviewing", title: "In Review", dot: "dotPurple" },
        { key: "done", title: "Done", dot: "dotGreen" },
        { key: "failed", title: "Failed", dot: "dotRed" },
        { key: "cancelled", title: "Cancelled", dot: "dotGray" },
      ] as const satisfies IssueBoardColumn[],
    [],
  );

  return {
    // router
    selectedIssueId,
    hasDetail,
    navigate,
    location,
    closeDetail,

    // auth
    auth,
    canRun,
    canChangeStatus,

    // state
    projects,
    issues,
    loading,
    error,
    clearError,
    searchText,
    setSearchText,
    selectedProjectId,
    setSelectedProjectId,
    dragging,
    setDragging,
    dropStatus,
    setDropStatus,
    moving,
    isMobile,

    // derived
    effectiveProjectId,
    visibleIssues,
    issuesByStatus,
    columns,
    showArchivedOnBoard,

    // outlet
    outletContext,
    onIssueUpdated,

    // actions
    refresh,
    readDragPayload,
    moveIssue,
  } as const;
}
