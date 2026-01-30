import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

import {
  decideAcpSessionPermission,
  setAcpSessionMode,
  setAcpSessionModel,
} from "../../api/acpSessions";
import { getIssue } from "../../api/issues";
import { getRun, listRunEvents, pauseRun, promptRun, uploadRunAttachment } from "../../api/runs";
import { useAuth } from "../../auth/AuthContext";
import { useWsClient, type WsMessage } from "../../hooks/useWsClient";
import type { Event, Issue, Run } from "../../types";
import { readFileAsBase64 } from "../../utils/files";

import { readSessionState } from "./readSessionState";

export type SessionController = ReturnType<typeof useSessionController>;

type PermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

type PermissionRequestItem = {
  requestId: string;
  sessionId: string;
  promptId: string | null;
  toolCall?: unknown;
  options: PermissionOption[];
  createdAt?: string;
};

export function useSessionController() {
  const params = useParams();
  const runId = params.runId ?? "";
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [run, setRun] = useState<Run | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [liveEventIds, setLiveEventIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const wsStatusRef = useRef<"connecting" | "open" | "closed">("connecting");
  const [chatText, setChatText] = useState("");
  const [pendingImages, setPendingImages] = useState<
    Array<{ id: string; uri: string; mimeType: string; name?: string; size: number }>
  >([]);
  const uploadSeqRef = useRef(0);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [settingMode, setSettingMode] = useState(false);
  const [settingModel, setSettingModel] = useState(false);
  const [resolvingPermissionId, setResolvingPermissionId] = useState<string | null>(null);
  const [resolvedPermissionIds, setResolvedPermissionIds] = useState<Set<string>>(new Set());

  const clearErrorTimer = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const setTransientError = useCallback(
    (message: string | null) => {
      clearErrorTimer();
      setError(message);
      if (message) {
        errorTimerRef.current = window.setTimeout(() => {
          setError(null);
          errorTimerRef.current = null;
        }, 4000);
      }
    },
    [clearErrorTimer],
  );

  const sessionState = useMemo(() => readSessionState(events), [events]);
  const sessionId = run?.acpSessionId ?? null;
  const isAdmin = auth.user?.role === "admin";

  const permissionRequests = useMemo(() => {
    const items: PermissionRequestItem[] = [];
    for (const event of events) {
      const payload = (event as any)?.payload;
      if (!payload || typeof payload !== "object") continue;
      if ((payload as any).type !== "permission_request") continue;
      const requestIdRaw = (payload as any).request_id;
      if (requestIdRaw == null) continue;
      const requestId = String(requestIdRaw);
      if (resolvedPermissionIds.has(requestId)) continue;

      const sessionIdRaw = typeof (payload as any).session_id === "string" ? payload.session_id : "";
      const sessionIdValue = sessionIdRaw || run?.acpSessionId || "";
      if (!sessionIdValue) continue;

      const optionsRaw = Array.isArray((payload as any).options) ? (payload as any).options : [];
      const options = optionsRaw
        .filter((o: any) => o && typeof o === "object" && typeof o.optionId === "string")
        .map((o: any) => ({
          optionId: String(o.optionId),
          name: typeof o.name === "string" ? o.name : undefined,
          kind: typeof o.kind === "string" ? o.kind : undefined,
        }));

      items.push({
        requestId,
        sessionId: sessionIdValue,
        promptId:
          typeof (payload as any).prompt_id === "string" ? String((payload as any).prompt_id) : null,
        toolCall: (payload as any).tool_call,
        options,
        createdAt: event.timestamp,
      });
    }

    items.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
    return items;
  }, [events, resolvedPermissionIds, run?.acpSessionId]);

  useEffect(() => () => clearErrorTimer(), [clearErrorTimer]);

  const requireLogin = useCallback((): boolean => {
    if (auth.user) return true;
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    navigate(`/login?next=${next}`);
    return false;
  }, [auth.user, location.pathname, location.search, navigate]);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!runId) return;
      if (!opts?.silent) setRefreshing(true);
      setTransientError(null);
      try {
        const r = await getRun(runId);
        setRun(r);

        const [es, iss] = await Promise.all([listRunEvents(runId), getIssue(r.issueId)]);
        setEvents([...es].reverse());
        setIssue(iss);
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!opts?.silent) setRefreshing(false);
        setLoading(false);
      }
    },
    [runId, setTransientError],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!runId) return;
    setLiveEventIds(new Set());
    setResolvedPermissionIds(new Set());
  }, [runId]);

  const onWs = useCallback(
    (msg: WsMessage) => {
      if (!runId) return;
      if (msg.run_id !== runId) return;

      if (msg.type === "event_added" && msg.event) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event!.id)) return prev;
          const next = [...prev, msg.event!];
          return next.length > 800 ? next.slice(next.length - 800) : next;
        });
        setLiveEventIds((prev) => {
          const next = new Set(prev);
          next.add(msg.event!.id);
          return next;
        });

        const payload = (msg.event as any).payload;
        if (payload?.type === "prompt_result") {
          setRun((r) =>
            r
              ? {
                  ...r,
                  status: "completed",
                  completedAt: r.completedAt ?? new Date().toISOString(),
                }
              : r,
          );
          void refresh({ silent: true });
        }
        if (payload?.type === "init_result" && payload?.ok === false) {
          setRun((r) =>
            r
              ? { ...r, status: "failed", completedAt: r.completedAt ?? new Date().toISOString() }
              : r,
          );
          void refresh({ silent: true });
        }
        if (payload?.type === "session_created" && typeof payload.session_id === "string") {
          setRun((r) => (r ? { ...r, acpSessionId: payload.session_id } : r));
        }
        return;
      }

      if (msg.type === "artifact_added" && msg.artifact) {
        setRun((r) => {
          if (!r) return r;
          const artifacts = [...(r.artifacts ?? [])];
          if (!artifacts.some((a) => a.id === msg.artifact!.id)) artifacts.unshift(msg.artifact!);

          const branch =
            (msg.artifact as any)?.type === "branch"
              ? (msg.artifact as any)?.content?.branch
              : undefined;
          const branchName = typeof branch === "string" ? branch : r.branchName;

          return { ...r, artifacts, branchName };
        });
      }
    },
    [refresh, runId],
  );
  const ws = useWsClient(onWs);
  useEffect(() => {
    wsStatusRef.current = ws.status;
  }, [ws.status]);

  const onPause = useCallback(async () => {
    if (!runId) return;
    if (!requireLogin()) return;
    setTransientError(null);
    setPausing(true);
    try {
      await pauseRun(runId);
    } catch (err) {
      setTransientError(err instanceof Error ? err.message : String(err));
    } finally {
      setPausing(false);
    }
  }, [requireLogin, runId, setTransientError]);

  const onSetMode = useCallback(
    async (modeId: string) => {
      if (!runId) return;
      if (!sessionId) return;
      if (!requireLogin()) return;

      const id = modeId.trim();
      if (!id) return;

      setTransientError(null);
      setSettingMode(true);
      try {
        await setAcpSessionMode(runId, sessionId, id);
        void refresh({ silent: true });
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingMode(false);
      }
    },
    [refresh, requireLogin, runId, sessionId, setTransientError],
  );

  const onSetModel = useCallback(
    async (modelId: string) => {
      if (!runId) return;
      if (!sessionId) return;
      if (!requireLogin()) return;

      const id = modelId.trim();
      if (!id) return;

      setTransientError(null);
      setSettingModel(true);
      try {
        await setAcpSessionModel(runId, sessionId, id);
        void refresh({ silent: true });
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        setSettingModel(false);
      }
    },
    [refresh, requireLogin, runId, sessionId, setTransientError],
  );

  const onResolvePermission = useCallback(
    async (req: PermissionRequestItem, decision: { outcome: "selected" | "cancelled"; optionId?: string }) => {
      if (!runId) return;
      if (!req.sessionId) return;
      if (!requireLogin()) return;
      if (!isAdmin) {
        setTransientError("需要管理员权限才能审批权限请求");
        return;
      }

      setTransientError(null);
      setResolvingPermissionId(req.requestId);
      try {
        await decideAcpSessionPermission({
          runId,
          sessionId: req.sessionId,
          requestId: req.requestId,
          outcome: decision.outcome,
          optionId: decision.optionId,
        });
        setResolvedPermissionIds((prev) => {
          const next = new Set(prev);
          next.add(req.requestId);
          return next;
        });
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolvingPermissionId(null);
      }
    },
    [isAdmin, requireLogin, runId, setTransientError],
  );

  const onSend = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!runId) return;
      if (!requireLogin()) return;
      if (uploadingImages) return;

      const text = chatText.trim();
      const prompt = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...pendingImages.map((img) => ({
          type: "image" as const,
          mimeType: img.mimeType,
          uri: img.uri,
        })),
      ];
      if (!prompt.length) return;

      setTransientError(null);
      setSending(true);
      setChatText("");
      setPendingImages([]);
      try {
        await promptRun(runId, prompt);
        if (wsStatusRef.current !== "open") {
          void refresh({ silent: true });
        }
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
    },
    [chatText, pendingImages, refresh, requireLogin, runId, setTransientError, uploadingImages],
  );

  const onDropFiles = useCallback(
    async (filesLike: FileList | File[]) => {
      if (!runId) return;
      if (!requireLogin()) return;

      const files = Array.isArray(filesLike) ? filesLike : Array.from(filesLike);
      const images = files.filter(
        (f) => f && typeof f.type === "string" && f.type.startsWith("image/"),
      );
      if (!images.length) {
        setTransientError("本期只支持图片上传（image/*）");
        return;
      }

      const seq = (uploadSeqRef.current += 1);
      setTransientError(null);
      setUploadingImages(true);
      try {
        for (const f of images) {
          const base64 = await readFileAsBase64(f);
          const attachment = await uploadRunAttachment(runId, {
            mimeType: f.type,
            base64,
            name: f.name,
          });
          setPendingImages((prev) => {
            if (prev.some((p) => p.id === attachment.id)) return prev;
            return [
              ...prev,
              {
                id: attachment.id,
                uri: attachment.uri,
                mimeType: attachment.mimeType,
                name: f.name,
                size: attachment.size,
              },
            ];
          });
        }
      } catch (err) {
        setTransientError(err instanceof Error ? err.message : String(err));
      } finally {
        if (uploadSeqRef.current === seq) setUploadingImages(false);
      }
    },
    [requireLogin, runId, setTransientError],
  );

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return {
    // auth & router
    auth,
    navigate,
    location,
    runId,

    // ws
    ws,

    // data
    run,
    issue,
    events,
    liveEventIds,

    // derived
    sessionState,
    sessionId,
    permissionRequests,
    resolvingPermissionId,
    isAdmin,

    // ui state
    loading,
    refreshing,
    error,
    chatText,
    setChatText,
    pendingImages,
    uploadingImages,
    sending,
    pausing,
    settingMode,
    settingModel,

    // actions
    refresh,
    onPause,
    onSetMode,
    onSetModel,
    onResolvePermission,
    onSend,
    onDropFiles,
    removePendingImage,
  } as const;
}
