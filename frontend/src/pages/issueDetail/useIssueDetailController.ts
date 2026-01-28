import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { listAgents } from "../../api/agents";
import { getIssue, startIssue } from "../../api/issues";
import { analyzeIssue as analyzePmIssue, dispatchIssue as dispatchPmIssue, getIssueNextAction } from "../../api/pm";
import { listRoles } from "../../api/roles";
import { cancelRun, completeRun, getRun, listRunEvents, pauseRun, promptRun, submitRun } from "../../api/runs";
import { startStep as startTaskStep, rollbackTask as rollbackTaskToStep } from "../../api/steps";
import { createIssueTask, listIssueTasks, listTaskTemplates } from "../../api/tasks";
import { useAuth } from "../../auth/AuthContext";
import { useWsClient, type WsMessage } from "../../hooks/useWsClient";
import type {
  Agent,
  Artifact,
  Event,
  Issue,
  PmAnalysis,
  PmAnalysisMeta,
  PmNextAction,
  PmRisk,
  RoleTemplate,
  Run,
  Step,
  Task,
  TaskTemplate,
  TaskTrack,
  UserRole,
} from "../../types";
import { getAgentEnvLabel, getAgentSandboxLabel } from "../../utils/agentLabels";
import { canManageTasks, canPauseAgent, canRunIssue, canUsePmTools } from "../../utils/permissions";

import { pickTemplateKey, sortTemplatesByPriority } from "./taskTemplates";
import type { IssuesOutletContext } from "./types";

export type IssueDetailController = ReturnType<typeof useIssueDetailController>;

export function useIssueDetailController(opts: { issueId: string; outlet: IssuesOutletContext | null }) {
  const issueId = opts.issueId;
  const outlet = opts.outlet;

  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const userRole = auth.user?.role ?? null;
  const allowRunActions = canRunIssue(userRole);
  const allowTaskOps = canManageTasks(userRole);
  const allowPause = canPauseAgent(userRole);
  const allowPmTools = canUsePmTools(userRole);

  const [issue, setIssue] = useState<Issue | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  const issueRef = useRef<Issue | null>(null);

  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([]);
  const [taskTemplatesLoaded, setTaskTemplatesLoaded] = useState(false);
  const [taskTemplatesError, setTaskTemplatesError] = useState<string | null>(null);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>("");
  const [selectedTaskTrack, setSelectedTaskTrack] = useState<TaskTrack | "">("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [startingStepId, setStartingStepId] = useState<string | null>(null);
  const [rollingBackStepId, setRollingBackStepId] = useState<string | null>(null);
  const [submittingRunId, setSubmittingRunId] = useState<string | null>(null);
  const [humanForms, setHumanForms] = useState<
    Record<
      string,
      { verdict: "approve" | "changes_requested"; comment: string; squash?: boolean; mergeCommitMessage?: string }
    >
  >({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [selectedRoleKey, setSelectedRoleKey] = useState<string>("");
  const [worktreeName, setWorktreeName] = useState<string>("");
  const [chatText, setChatText] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [cancellingRun, setCancellingRun] = useState(false);
  const [completingRun, setCompletingRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [pmLoading, setPmLoading] = useState(false);
  const [pmDispatching, setPmDispatching] = useState(false);
  const [pmAnalysis, setPmAnalysis] = useState<PmAnalysis | null>(null);
  const [pmMeta, setPmMeta] = useState<PmAnalysisMeta | null>(null);
  const [pmError, setPmError] = useState<string | null>(null);
  const [pmOpen, setPmOpen] = useState(false);
  const [nextAction, setNextAction] = useState<PmNextAction | null>(null);
  const [nextActionLoading, setNextActionLoading] = useState(false);
  const [nextActionError, setNextActionError] = useState<string | null>(null);

  const refreshNextAction = useCallback(async () => {
    if (!issueId) return;
    setNextActionLoading(true);
    setNextActionError(null);
    try {
      const res = await getIssueNextAction(issueId);
      setNextAction(res);
    } catch (e) {
      setNextAction(null);
      setNextActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setNextActionLoading(false);
    }
  }, [issueId]);

  const currentRunId = useMemo(() => selectedRunId || run?.id || issue?.runs?.[0]?.id || "", [issue, run, selectedRunId]);
  const currentAgentId = useMemo(() => run?.agentId ?? issue?.runs?.[0]?.agentId ?? "", [issue, run]);
  const currentAgent = useMemo(
    () => (currentAgentId ? agents.find((a) => a.id === currentAgentId) ?? null : null),
    [agents, currentAgentId],
  );
  const agentOnline = currentAgent ? currentAgent.status === "online" : true;
  const currentAgentEnvLabel = useMemo(() => getAgentEnvLabel(currentAgent), [currentAgent]);
  const currentAgentSandbox = useMemo(() => getAgentSandboxLabel(currentAgent), [currentAgent]);

  const selectedAgent = useMemo(
    () => (selectedAgentId ? agents.find((a) => a.id === selectedAgentId) ?? null : null),
    [agents, selectedAgentId],
  );
  const selectedAgentEnvLabel = useMemo(() => getAgentEnvLabel(selectedAgent), [selectedAgent]);
  const selectedAgentSandbox = useMemo(() => getAgentSandboxLabel(selectedAgent), [selectedAgent]);

  const sessionId = run?.acpSessionId ?? null;
  const sessionKnown = !!sessionId;

  const runArtifacts = run?.artifacts ?? [];
  const showArtifacts = runArtifacts.length > 0;
  const showChanges =
    Boolean(run?.branchName) || runArtifacts.some((a) => a.type === "branch" || a.type === "pr" || a.type === "patch");

  const pmFromArtifact = useMemo(() => {
    const artifacts = run?.artifacts ?? [];
    const reports = artifacts.filter((a) => a.type === "report");
    const sorted = [...reports].sort((a, b) => {
      const ta = Date.parse((a as any).createdAt ?? "") || 0;
      const tb = Date.parse((b as any).createdAt ?? "") || 0;
      return tb - ta;
    });
    for (const art of sorted) {
      const content = (art as any)?.content;
      if (!content || typeof content !== "object") continue;
      if ((content as any).kind !== "pm_analysis") continue;
      const analysis = (content as any).analysis;
      if (!analysis || typeof analysis !== "object") continue;
      return {
        analysis: analysis as PmAnalysis,
        meta: ((content as any).meta ?? null) as PmAnalysisMeta | null,
        reason: typeof (content as any).reason === "string" ? (content as any).reason : null,
        createdAt: typeof (content as any).createdAt === "string" ? (content as any).createdAt : (art as any).createdAt,
        artifact: art as Artifact,
      };
    }
    return null;
  }, [run?.artifacts]);

  const effectivePmAnalysis = pmAnalysis ?? pmFromArtifact?.analysis ?? null;
  const effectivePmMeta = pmMeta ?? pmFromArtifact?.meta ?? null;

  const recommendedAgentName = useMemo(() => {
    const id = effectivePmAnalysis?.recommendedAgentId ?? "";
    if (!id) return null;
    const a = agents.find((x) => x.id === id);
    return a ? a.name : id;
  }, [agents, effectivePmAnalysis?.recommendedAgentId]);

  const recommendedRoleLabel = useMemo(() => {
    const key = effectivePmAnalysis?.recommendedRoleKey ?? "";
    if (!key) return null;
    const r = roles.find((x) => x.key === key);
    return r ? `${r.displayName} (${r.key})` : key;
  }, [roles, effectivePmAnalysis?.recommendedRoleKey]);

  const canPmDispatch = Boolean(issueId) && issue?.status === "pending" && !currentRunId;

  useEffect(() => {
    issueRef.current = issue;
  }, [issue]);

  const selectedRunIdRef = useRef<string>("");
  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    setTaskTemplatesLoaded(false);
    setTaskTemplatesError(null);
    listTaskTemplates()
      .then((ts) => {
        const list = Array.isArray(ts) ? ts : [];
        setTaskTemplates(list);
        setTaskTemplatesLoaded(true);
      })
      .catch((err) => {
        setTaskTemplatesError(err instanceof Error ? err.message : String(err));
        setTaskTemplatesLoaded(true);
      });
  }, []);

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = Boolean(opts?.silent);
      const isInitial = !issueRef.current;
      if (!silent) {
        if (isInitial) setLoading(true);
        else setRefreshing(true);
      }
      setError(null);
      setTasksLoaded(false);
      setTasksError(null);
      try {
        const i = await getIssue(issueId);
        setIssue(i);
        outlet?.onIssueUpdated?.(i);

        listIssueTasks(issueId)
          .then((ts) => {
            setTasks(ts);
            setTasksError(null);
            setTasksLoaded(true);
          })
          .catch((err) => {
            setTasks([]);
            setTasksError(err instanceof Error ? err.message : String(err));
            setTasksLoaded(true);
          });

        const desiredRunId = selectedRunIdRef.current || i.runs?.[0]?.id || "";
        if (desiredRunId) {
          try {
            const [r, es] = await Promise.all([getRun(desiredRunId), listRunEvents(desiredRunId)]);
            setRun(r);
            setSelectedRunId(desiredRunId);
            setEvents([...es].reverse());
          } catch (e) {
            const latest = i.runs?.[0]?.id || "";
            if (latest && latest !== desiredRunId) {
              const [r, es] = await Promise.all([getRun(latest), listRunEvents(latest)]);
              setRun(r);
              setSelectedRunId(latest);
              setEvents([...es].reverse());
            } else {
              throw e;
            }
          }
        } else {
          setRun(null);
          setSelectedRunId("");
          setEvents([]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!silent) {
          if (isInitial) setLoading(false);
          else setRefreshing(false);
        }
      }
    },
    [issueId, outlet],
  );

  useEffect(() => {
    if (!issueId) return;
    setSelectedRunId("");
    selectedRunIdRef.current = "";
    setNextAction(null);
    setNextActionError(null);
    refresh();
  }, [issueId, refresh]);

  useEffect(() => {
    if (!pmOpen) return;
    if (!issueId) return;
    void refreshNextAction();
  }, [issueId, pmOpen, refreshNextAction]);

  useEffect(() => {
    listAgents()
      .then((as) => {
        setAgents(as);
        setAgentsError(null);
        setAgentsLoaded(true);
      })
      .catch((err) => {
        setAgentsError(err instanceof Error ? err.message : String(err));
        setAgentsLoaded(true);
      });
  }, []);

  useEffect(() => {
    const projectId = issue?.projectId ?? "";
    if (!projectId) return;

    setRolesLoaded(false);
    setRolesError(null);
    listRoles(projectId)
      .then((rs) => {
        setRoles(rs);
        setRolesLoaded(true);
      })
      .catch((err) => {
        setRolesError(err instanceof Error ? err.message : String(err));
        setRolesLoaded(true);
      });
  }, [issue?.projectId]);

  useEffect(() => {
    if (!issue) return;
    if (selectedRoleKey) return;
    const def = issue.project?.defaultRoleKey;
    if (typeof def === "string" && def.trim()) setSelectedRoleKey(def.trim());
  }, [issue, selectedRoleKey]);

  const refreshTasksOnly = useCallback(async () => {
    if (!issueId) return;
    try {
      const ts = await listIssueTasks(issueId);
      setTasks(ts);
      setTasksError(null);
      setTasksLoaded(true);
    } catch (err) {
      setTasks([]);
      setTasksError(err instanceof Error ? err.message : String(err));
      setTasksLoaded(true);
    }
  }, [issueId]);

  const onWs = useCallback(
    (msg: WsMessage) => {
      if (msg.type === "task_created" || msg.type === "task_updated" || msg.type === "step_updated") {
        if (msg.issue_id && msg.issue_id === issueId) {
          void refreshTasksOnly();
        }
        return;
      }

      if (!currentRunId) return;
      if (msg.run_id !== currentRunId) return;
      if (msg.type === "event_added" && msg.event) {
        setEvents((prev) => {
          if (prev.some((e) => e.id === msg.event!.id)) return prev;
          const next = [...prev, msg.event!];
          return next.length > 600 ? next.slice(next.length - 600) : next;
        });

        const payload = (msg.event as any).payload;
        if (payload?.type === "prompt_result") {
          setRun((r) => (r ? { ...r, status: "completed", completedAt: r.completedAt ?? new Date().toISOString() } : r));
          void refresh({ silent: true });
        }
        if (payload?.type === "init_result" && payload?.ok === false) {
          setRun((r) => (r ? { ...r, status: "failed", completedAt: r.completedAt ?? new Date().toISOString() } : r));
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

          const branch = (msg.artifact as any)?.type === "branch" ? (msg.artifact as any)?.content?.branch : undefined;
          const branchName = typeof branch === "string" ? branch : r.branchName;

          return { ...r, artifacts, branchName };
        });
        return;
      }
    },
    [currentRunId, issueId, refresh, refreshTasksOnly],
  );
  const ws = useWsClient(onWs);

  const availableAgents = useMemo(
    () => agents.filter((a) => a.status === "online" && a.currentLoad < a.maxConcurrentRuns),
    [agents],
  );
  const selectedAgentReady = selectedAgent ? selectedAgent.status === "online" && selectedAgent.currentLoad < selectedAgent.maxConcurrentRuns : false;
  const canStartRun =
    allowRunActions &&
    Boolean(issueId) &&
    (selectedAgentId ? selectedAgentReady : !agentsLoaded || !!agentsError || availableAgents.length > 0);

  function requireLogin(): boolean {
    if (auth.user) return true;
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    navigate(`/login?next=${next}`);
    return false;
  }

  async function onStartRun() {
    if (!issueId) return;
    if (!requireLogin()) return;
    if (!allowRunActions) {
      setError("当前账号无权限操作 Run");
      return;
    }
    setError(null);
    setRefreshing(true);
    try {
      const res = await startIssue(issueId, {
        agentId: selectedAgentId || undefined,
        roleKey: selectedRoleKey || undefined,
        worktreeName: worktreeName.trim() ? worktreeName.trim() : undefined,
      });
      setSelectedRunId(res.run.id);
      selectedRunIdRef.current = res.run.id;
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onCancelRun() {
    if (!currentRunId) return;
    if (!requireLogin()) return;
    if (!allowRunActions) {
      setError("当前账号无权限操作 Run");
      return;
    }
    if (cancellingRun || completingRun) return;
    setError(null);
    setCancellingRun(true);
    try {
      const r = await cancelRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingRun(false);
    }
  }

  async function onCompleteRun() {
    if (!currentRunId) return;
    if (!requireLogin()) return;
    if (!allowRunActions) {
      setError("当前账号无权限操作 Run");
      return;
    }
    if (cancellingRun || completingRun) return;
    setError(null);
    setCompletingRun(true);
    try {
      const r = await completeRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompletingRun(false);
    }
  }

  async function onPauseRun() {
    if (!currentRunId) return;
    if (!requireLogin()) return;
    if (!allowPause) {
      setError("当前账号无权限暂停 Agent");
      return;
    }
    setError(null);
    setPausing(true);
    try {
      await pauseRun(currentRunId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPausing(false);
    }
  }

  function getPmRiskBadge(risk: PmRisk) {
    const color = risk === "low" ? "green" : risk === "high" ? "red" : "orange";
    const label = risk === "low" ? "低风险" : risk === "high" ? "高风险" : "中风险";
    return { color, label } as const;
  }

  async function onPmAnalyze() {
    if (!issueId) return;
    if (!requireLogin()) return;
    if (!allowPmTools) {
      setPmError("需要 PM 或管理员权限");
      return;
    }
    setPmError(null);
    setPmLoading(true);
    try {
      const res = await analyzePmIssue(issueId);
      setPmAnalysis(res.analysis);
      setPmMeta(res.meta);
    } catch (e) {
      setPmError(e instanceof Error ? e.message : String(e));
    } finally {
      setPmLoading(false);
    }
  }

  async function onPmDispatch() {
    if (!issueId) return;
    if (!requireLogin()) return;
    if (!allowPmTools) {
      setPmError("需要 PM 或管理员权限");
      return;
    }
    setPmError(null);
    setPmDispatching(true);
    try {
      await dispatchPmIssue(issueId, "ui_pm_dispatch");
      await refresh({ silent: true });
    } catch (e) {
      setPmError(e instanceof Error ? e.message : String(e));
    } finally {
      setPmDispatching(false);
    }
  }

  function onPmApplyRecommendation() {
    if (!effectivePmAnalysis) return;
    const roleKey = effectivePmAnalysis.recommendedRoleKey ?? "";
    const agentId = effectivePmAnalysis.recommendedAgentId ?? "";
    const track = effectivePmAnalysis.recommendedTrack ?? "";
    if (roleKey) setSelectedRoleKey(roleKey);
    if (agentId) setSelectedAgentId(agentId);
    if (track) setSelectedTaskTrack(track);
  }

  async function onSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!currentRunId) return;
    if (!requireLogin()) return;
    if (!allowRunActions) {
      setError("当前账号无权限与 Agent 对话");
      return;
    }
    if (run && run.executorType !== "agent") {
      setError("当前 Run 不是 Agent 执行器，无法对话");
      return;
    }
    if (currentAgent && currentAgent.status !== "online") {
      setError("当前 Agent 已离线，无法继续对话");
      return;
    }
    const text = chatText.trim();
    if (!text) return;
    setError(null);
    setSending(true);
    try {
      await promptRun(currentRunId, text);
      setChatText("");
      await refresh({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  const templatesByKey = useMemo(() => {
    const map: Record<string, TaskTemplate> = {};
    for (const t of taskTemplates) {
      map[t.key] = t;
    }
    return map;
  }, [taskTemplates]);

  const selectableTaskTemplates = useMemo(() => taskTemplates.filter((t) => !t.deprecated), [taskTemplates]);

  const visibleTaskTemplates = useMemo(() => {
    if (!selectedTaskTrack) return selectableTaskTemplates;
    return selectableTaskTemplates.filter((t) => !t.track || t.track === selectedTaskTrack);
  }, [selectableTaskTemplates, selectedTaskTrack]);

  const visibleTaskTemplatesByTrack = useMemo(() => {
    const groups: Record<string, TaskTemplate[]> = { quick: [], planning: [], enterprise: [], other: [] };
    for (const t of visibleTaskTemplates) {
      if (t.track === "quick") groups.quick.push(t);
      else if (t.track === "planning") groups.planning.push(t);
      else if (t.track === "enterprise") groups.enterprise.push(t);
      else groups.other.push(t);
    }
    groups.quick = sortTemplatesByPriority("quick", groups.quick);
    groups.planning = sortTemplatesByPriority("planning", groups.planning);
    groups.enterprise = sortTemplatesByPriority("enterprise", groups.enterprise);
    groups.other = [...groups.other].sort((a, b) => String(a.displayName ?? "").localeCompare(String(b.displayName ?? ""), "zh-CN"));
    return groups;
  }, [visibleTaskTemplates]);

  const hasNonTerminalTask = useMemo(() => {
    if (!tasksLoaded || tasksError) return false;
    return tasks.some((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled");
  }, [tasks, tasksError, tasksLoaded]);

  const canCreateAnotherTask = tasksLoaded && !tasksError && !hasNonTerminalTask;

  useEffect(() => {
    if (!taskTemplatesLoaded) return;
    setSelectedTemplateKey((prev) => pickTemplateKey({ templates: taskTemplates, track: selectedTaskTrack, currentKey: prev }));
  }, [selectedTaskTrack, taskTemplates, taskTemplatesLoaded]);

  const runsByStepId = useMemo(() => {
    const map: Record<string, Run[]> = {};
    const taskRuns: Run[] = [];
    for (const t of tasks) {
      const rs = t.runs ?? [];
      for (const r of rs) taskRuns.push(r);
    }

    const source = taskRuns.length ? taskRuns : (issue?.runs ?? []);
    for (const r of source) {
      const sid = r.stepId ?? "";
      if (!sid) continue;
      if (!map[sid]) map[sid] = [];
      map[sid].push(r);
    }
    return map;
  }, [issue?.runs, tasks]);

  function latestRunForStep(stepId: string): Run | null {
    const list = runsByStepId[stepId];
    return Array.isArray(list) && list.length ? list[0] : null;
  }

  function getHumanForm(runId: string) {
    return humanForms[runId] ?? { verdict: "approve" as const, comment: "" };
  }

  function patchHumanForm(runId: string, patch: Partial<ReturnType<typeof getHumanForm>>) {
    setHumanForms((prev) => {
      const base = prev[runId] ?? { verdict: "approve" as const, comment: "" };
      return { ...prev, [runId]: { ...base, ...patch } };
    });
  }

  function roleAllowsHumanSubmit(stepKind: string, role: UserRole | null): boolean {
    if (!role) return false;
    if (stepKind === "code.review" || stepKind === "pr.merge") return role === "reviewer" || role === "admin";
    if (stepKind === "prd.review") return role === "pm" || role === "admin";
    return true;
  }

  async function onCreateTask() {
    if (!issueId) return;
    if (!selectedTemplateKey) return;
    if (!requireLogin()) return;
    if (!allowTaskOps) {
      setError("需要开发或管理员权限");
      return;
    }

    setCreatingTask(true);
    setError(null);
    try {
      const created = await createIssueTask(issueId, {
        templateKey: selectedTemplateKey,
        track: selectedTaskTrack ? selectedTaskTrack : undefined,
      });
      setTasks((prev) => [created, ...prev]);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingTask(false);
    }
  }

  async function onStartStep(step: Step) {
    if (!requireLogin()) return;
    if (!allowTaskOps) {
      setError("需要开发或管理员权限");
      return;
    }
    setStartingStepId(step.id);
    setError(null);
    try {
      const roleKey =
        step.executorType === "agent"
          ? (step.roleKey?.trim() ? step.roleKey.trim() : selectedRoleKey?.trim() ? selectedRoleKey.trim() : undefined)
          : undefined;
      const res = await startTaskStep(step.id, { roleKey });
      setSelectedRunId(res.run.id);
      selectedRunIdRef.current = res.run.id;
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingStepId(null);
    }
  }

  async function onRollback(task: Task, step: Step) {
    if (!requireLogin()) return;
    if (!allowTaskOps) {
      setError("需要开发或管理员权限");
      return;
    }
    setRollingBackStepId(step.id);
    setError(null);
    try {
      const updated = await rollbackTaskToStep(task.id, step.id);
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRollingBackStepId(null);
    }
  }

  async function onSelectRun(runId: string) {
    if (!runId) return;
    setError(null);
    setRefreshing(true);
    try {
      const [r, es] = await Promise.all([getRun(runId), listRunEvents(runId)]);
      setRun(r);
      setSelectedRunId(runId);
      selectedRunIdRef.current = runId;
      setEvents([...es].reverse());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  async function onSubmitHuman(step: Step, runId: string) {
    if (!requireLogin()) return;
    const role = auth.user?.role ?? null;
    if (!roleAllowsHumanSubmit(step.kind, role)) {
      setError("当前账号无权限提交该步骤");
      return;
    }

    const form = getHumanForm(runId);
    const payload =
      step.kind === "pr.merge"
        ? { verdict: "approve" as const, squash: Boolean(form.squash), mergeCommitMessage: form.mergeCommitMessage?.trim() || undefined }
        : { verdict: form.verdict, comment: form.comment?.trim() || undefined };

    setSubmittingRunId(runId);
    setError(null);
    try {
      await submitRun(runId, payload);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmittingRunId(null);
    }
  }

  return {
    // identity
    issueId,

    // auth & permissions
    auth,
    userRole,
    allowRunActions,
    allowTaskOps,
    allowPause,
    allowPmTools,

    // router
    navigate,
    location,

    // ws
    ws,

    // core state
    issue,
    setIssue,
    run,
    setRun,
    selectedRunId,
    setSelectedRunId,
    events,
    setEvents,

    // run selection refs
    selectedRunIdRef,

    // loading & errors
    loading,
    refreshing,
    error,
    setError,

    // refresh
    refresh,

    // agents / roles
    agents,
    agentsLoaded,
    agentsError,
    selectedAgentId,
    setSelectedAgentId,
    roles,
    rolesLoaded,
    rolesError,
    selectedRoleKey,
    setSelectedRoleKey,
    worktreeName,
    setWorktreeName,

    // derived: run/agent
    currentRunId,
    currentAgentId,
    currentAgent,
    agentOnline,
    currentAgentEnvLabel,
    currentAgentSandbox,
    selectedAgent,
    selectedAgentEnvLabel,
    selectedAgentSandbox,
    availableAgents,
    canStartRun,

    // session / artifacts
    sessionId,
    sessionKnown,
    runArtifacts,
    showArtifacts,
    showChanges,
    changesOpen,
    setChangesOpen,

    // console input / run actions
    chatText,
    setChatText,
    sending,
    pausing,
    cancellingRun,
    completingRun,
    onStartRun,
    onCancelRun,
    onCompleteRun,
    onPauseRun,
    onSendPrompt,

    // tasks templates & tasks
    taskTemplates,
    taskTemplatesLoaded,
    taskTemplatesError,
    selectedTemplateKey,
    setSelectedTemplateKey,
    selectedTaskTrack,
    setSelectedTaskTrack,
    tasks,
    setTasks,
    tasksLoaded,
    tasksError,
    creatingTask,
    startingStepId,
    rollingBackStepId,
    submittingRunId,
    humanForms,

    templatesByKey,
    visibleTaskTemplatesByTrack,
    canCreateAnotherTask,
    latestRunForStep,
    getHumanForm,
    patchHumanForm,
    roleAllowsHumanSubmit,
    onCreateTask,
    onStartStep,
    onRollback,
    onSelectRun,
    onSubmitHuman,

    // pm / next action
    pmLoading,
    pmDispatching,
    pmError,
    pmOpen,
    setPmOpen,
    pmAnalysis,
    pmMeta,
    pmFromArtifact,
    effectivePmAnalysis,
    effectivePmMeta,
    recommendedAgentName,
    recommendedRoleLabel,
    canPmDispatch,
    nextAction,
    nextActionLoading,
    nextActionError,
    refreshNextAction,
    onPmAnalyze,
    onPmDispatch,
    onPmApplyRecommendation,
    getPmRiskBadge,

    // outlet
    outlet,
  } as const;
}
