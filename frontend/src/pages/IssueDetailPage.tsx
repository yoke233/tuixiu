import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";

import { listAgents } from "../api/agents";
import { getIssue, startIssue } from "../api/issues";
import { analyzeIssue as analyzePmIssue, dispatchIssue as dispatchPmIssue } from "../api/pm";
import { listRoles } from "../api/roles";
import { cancelRun, completeRun, getRun, listRunEvents, pauseRun, promptRun, submitRun } from "../api/runs";
import { startStep as startTaskStep, rollbackTask as rollbackTaskToStep } from "../api/steps";
import { createIssueTask, listIssueTasks, listTaskTemplates } from "../api/tasks";
import { useAuth } from "../auth/AuthContext";
import { ArtifactList } from "../components/ArtifactList";
import { IssueRunCard } from "../components/IssueRunCard";
import { RunChangesPanel } from "../components/RunChangesPanel";
import { RunConsole } from "../components/RunConsole";
import { StatusBadge } from "../components/StatusBadge";
import { ThemeToggle } from "../components/ThemeToggle";
import { useWsClient, type WsMessage } from "../hooks/useWsClient";
import type { Agent, Artifact, Event, Issue, PmAnalysis, PmAnalysisMeta, PmRisk, RoleTemplate, Run, Step, Task, TaskTemplate, UserRole } from "../types";
import { getAgentEnvLabel, getAgentSandboxLabel } from "../utils/agentLabels";

type IssuesOutletContext = {
  onIssueUpdated?: (issue: Issue) => void;
};

export function IssueDetailPage() {
  const params = useParams();
  const issueId = params.id ?? "";
  const outlet = useOutletContext<IssuesOutletContext | null>();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [events, setEvents] = useState<Event[]>([]);
  const issueRef = useRef<Issue | null>(null);

  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([]);
  const [taskTemplatesLoaded, setTaskTemplatesLoaded] = useState(false);
  const [taskTemplatesError, setTaskTemplatesError] = useState<string | null>(null);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>("");
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [pmLoading, setPmLoading] = useState(false);
  const [pmDispatching, setPmDispatching] = useState(false);
  const [pmAnalysis, setPmAnalysis] = useState<PmAnalysis | null>(null);
  const [pmMeta, setPmMeta] = useState<PmAnalysisMeta | null>(null);
  const [pmError, setPmError] = useState<string | null>(null);

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
        setSelectedTemplateKey((prev) => prev || list[0]?.key || "template.dev.full");
      })
      .catch((err) => {
        setTaskTemplatesError(err instanceof Error ? err.message : String(err));
        setTaskTemplatesLoaded(true);
      });
  }, []);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
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
  }, [issueId, outlet]);

  useEffect(() => {
    if (!issueId) return;
    setSelectedRunId("");
    selectedRunIdRef.current = "";
    refresh();
  }, [issueId, refresh]);

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
    [currentRunId, issueId, refresh, refreshTasksOnly]
  );
  const ws = useWsClient(onWs);

  const availableAgents = useMemo(
    () => agents.filter((a) => a.status === "online" && a.currentLoad < a.maxConcurrentRuns),
    [agents],
  );
  const selectedAgentReady = selectedAgent ? selectedAgent.status === "online" && selectedAgent.currentLoad < selectedAgent.maxConcurrentRuns : false;
  const canStartRun = Boolean(issueId) && (selectedAgentId ? selectedAgentReady : !agentsLoaded || !!agentsError || availableAgents.length > 0);

  function requireLogin(): boolean {
    if (auth.user) return true;
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    navigate(`/login?next=${next}`);
    return false;
  }

  async function onStartRun() {
    if (!issueId) return;
    if (!requireLogin()) return;
    setError(null);
    setRefreshing(true);
    try {
      const res = await startIssue(issueId, {
        agentId: selectedAgentId || undefined,
        roleKey: selectedRoleKey || undefined,
        worktreeName: worktreeName.trim() ? worktreeName.trim() : undefined
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
    setError(null);
    try {
      const r = await cancelRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCompleteRun() {
    if (!currentRunId) return;
    if (!requireLogin()) return;
    setError(null);
    try {
      const r = await completeRun(currentRunId);
      setRun(r);
      await refresh({ silent: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onPauseRun() {
    if (!currentRunId) return;
    if (!requireLogin()) return;
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

  function renderPmRisk(risk: PmRisk) {
    const color = risk === "low" ? "green" : risk === "high" ? "red" : "orange";
    const label = risk === "low" ? "低风险" : risk === "high" ? "高风险" : "中风险";
    return <span className={`badge ${color}`}>{label}</span>;
  }

  async function onPmAnalyze() {
    if (!issueId) return;
    if (!requireLogin()) return;
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
    if (roleKey) setSelectedRoleKey(roleKey);
    if (agentId) setSelectedAgentId(agentId);
  }


  async function onSendPrompt(e: React.FormEvent) {
    e.preventDefault();
    if (!currentRunId) return;
    if (!requireLogin()) return;
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

    setCreatingTask(true);
    setError(null);
    try {
      const created = await createIssueTask(issueId, { templateKey: selectedTemplateKey });
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

  return (
    <div className="container">
      <div className="row spaceBetween">
        <Link to="/issues">← 返回</Link>
        <div className="row gap">
          <div className="muted">
            WS: {ws.status}
            {refreshing ? " · 同步中…" : ""}
          </div>
          <ThemeToggle />
        </div>
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      {loading && !issue ? (
        <div className="muted">加载中…</div>
      ) : issue ? (
        <>
          <section className="card">
            <h1>{issue.title}</h1>
            <div className="row gap">
              <StatusBadge status={issue.status} />
              <span className="muted">{new Date(issue.createdAt).toLocaleString()}</span>
            </div>
            {issue.description ? <p className="pre">{issue.description}</p> : null}
          </section>

          <section className="card">
            <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: 0 }}>任务</h2>
                <div className="muted">Task/Step（支持回滚重跑与多执行器）</div>
              </div>
              <div className="row gap" style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                <select
                  aria-label="选择任务模板"
                  value={selectedTemplateKey}
                  onChange={(e) => setSelectedTemplateKey(e.target.value)}
                  disabled={!taskTemplatesLoaded && !taskTemplatesError}
                >
                  <option value="">选择模板…</option>
                  {taskTemplates.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.displayName}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={onCreateTask} disabled={creatingTask || !selectedTemplateKey}>
                  {creatingTask ? "创建中…" : "创建任务"}
                </button>
                <button type="button" className="buttonSecondary" onClick={() => refresh()} disabled={refreshing}>
                  同步
                </button>
              </div>
            </div>

            {taskTemplatesError ? (
              <div className="muted" style={{ marginTop: 8 }} title={taskTemplatesError}>
                模板加载失败：{taskTemplatesError}
              </div>
            ) : null}
            {tasksError ? (
              <div className="muted" style={{ marginTop: 8 }} title={tasksError}>
                Task 加载失败：{tasksError}
              </div>
            ) : null}

            {!tasksLoaded ? (
              <div className="muted" style={{ marginTop: 10 }}>
                加载中…
              </div>
            ) : tasks.length ? (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {tasks.map((t, idx) => {
                  const template = templatesByKey[t.templateKey];
                  return (
                    <details key={t.id} open={idx === 0}>
                      <summary className="detailsSummary">
                        <div className="row spaceBetween" style={{ alignItems: "center" }}>
                          <div className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
                            <span className="toolSummaryTitle">{template?.displayName ?? t.templateKey}</span>
                            <StatusBadge status={t.status} />
                            {t.branchName ? <code title={t.branchName}>{t.branchName}</code> : null}
                          </div>
                          <span className="muted">{new Date(t.createdAt).toLocaleString()}</span>
                        </div>
                      </summary>

                      <div className="muted" style={{ marginTop: 8 }}>
                        taskId: <code title={t.id}>{t.id}</code>
                      </div>

                      <table className="table" style={{ marginTop: 10 }}>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Step</th>
                            <th>执行器</th>
                            <th>状态</th>
                            <th>Run</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.steps.map((s) => {
                            const latest = latestRunForStep(s.id);
                            const viewing = latest?.id ? currentRunId === latest.id : false;
                            const role = auth.user?.role ?? null;
                            const canSubmit = roleAllowsHumanSubmit(s.kind, role);
                            const form = latest?.id ? getHumanForm(latest.id) : null;

                            return (
                              <Fragment key={s.id}>
                                <tr>
                                  <td>{s.order}</td>
                                  <td>
                                    <div>
                                      <code title={s.key}>{s.key}</code>
                                    </div>
                                    <div className="muted" style={{ fontSize: 12 }}>
                                      {s.kind}
                                    </div>
                                  </td>
                                  <td>
                                    <code>{s.executorType}</code>
                                  </td>
                                  <td>
                                    <StatusBadge status={s.status} />
                                  </td>
                                  <td>
                                    {latest ? (
                                      <div style={{ display: "grid", gap: 4 }}>
                                        <code title={latest.id}>{latest.id}</code>
                                        <span className="muted" style={{ fontSize: 12 }}>
                                          {latest.status}
                                          {typeof latest.attempt === "number" ? ` · attempt ${latest.attempt}` : ""}
                                        </span>
                                      </div>
                                    ) : (
                                      <span className="muted">—</span>
                                    )}
                                  </td>
                                  <td>
                                    <div className="row gap" style={{ flexWrap: "wrap" }}>
                                      {latest?.id ? (
                                        <button
                                          type="button"
                                          className="buttonSecondary"
                                          onClick={() => void onSelectRun(latest.id)}
                                          disabled={viewing}
                                        >
                                          {viewing ? "查看中" : "查看"}
                                        </button>
                                      ) : null}

                                      <button
                                        type="button"
                                        onClick={() => void onStartStep(s)}
                                        disabled={s.status !== "ready" || startingStepId === s.id}
                                      >
                                        {startingStepId === s.id ? "启动中…" : "启动"}
                                      </button>

                                      <button
                                        type="button"
                                        className="buttonSecondary"
                                        onClick={() => void onRollback(t, s)}
                                        disabled={rollingBackStepId === s.id}
                                      >
                                        {rollingBackStepId === s.id ? "回滚中…" : "回滚到此步"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>

                                {s.status === "waiting_human" && latest?.id && latest.executorType === "human" ? (
                                  <tr>
                                    <td colSpan={6}>
                                      <div className="row gap" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
                                        {s.kind === "pr.merge" ? (
                                          <>
                                            <label className="label" style={{ margin: 0 }}>
                                              squash
                                              <input
                                                type="checkbox"
                                                checked={Boolean(form?.squash)}
                                                onChange={(e) => patchHumanForm(latest.id, { squash: e.target.checked })}
                                                disabled={submittingRunId === latest.id}
                                              />
                                            </label>
                                            <label className="label" style={{ margin: 0, minWidth: 320 }}>
                                              merge message（可选）
                                              <input
                                                value={form?.mergeCommitMessage ?? ""}
                                                onChange={(e) => patchHumanForm(latest.id, { mergeCommitMessage: e.target.value })}
                                                disabled={submittingRunId === latest.id}
                                                placeholder="留空使用默认"
                                              />
                                            </label>
                                            <button
                                              type="button"
                                              onClick={() => void onSubmitHuman(s, latest.id)}
                                              disabled={!canSubmit || submittingRunId === latest.id}
                                            >
                                              {submittingRunId === latest.id ? "合并中…" : "合并"}
                                            </button>
                                          </>
                                        ) : (
                                          <>
                                            <label className="label" style={{ margin: 0 }}>
                                              verdict
                                              <select
                                                value={form?.verdict ?? "approve"}
                                                onChange={(e) =>
                                                  patchHumanForm(latest.id, {
                                                    verdict: e.target.value as "approve" | "changes_requested",
                                                  })
                                                }
                                                disabled={submittingRunId === latest.id}
                                              >
                                                <option value="approve">approve</option>
                                                <option value="changes_requested">changes_requested</option>
                                              </select>
                                            </label>
                                            <label className="label" style={{ margin: 0, minWidth: 360 }}>
                                              comment（Markdown，可选）
                                              <textarea
                                                value={form?.comment ?? ""}
                                                onChange={(e) => patchHumanForm(latest.id, { comment: e.target.value })}
                                                disabled={submittingRunId === latest.id}
                                                placeholder="写评审意见/修改建议…"
                                              />
                                            </label>
                                            <button
                                              type="button"
                                              onClick={() => void onSubmitHuman(s, latest.id)}
                                              disabled={!canSubmit || submittingRunId === latest.id}
                                            >
                                              {submittingRunId === latest.id ? "提交中…" : "提交"}
                                            </button>
                                          </>
                                        )}
                                        {!canSubmit ? (
                                          <span className="muted">当前账号无权限提交该步骤</span>
                                        ) : null}
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </details>
                  );
                })}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 10 }}>
                暂无 Task（可从模板创建）
              </div>
            )}
          </section>

          <section className="card">
            <div className="row spaceBetween">
              <h2>PM</h2>
              <div className="row gap">
                <button type="button" onClick={onPmAnalyze} disabled={pmLoading || !issueId}>
                  {pmLoading ? "分析中…" : "分析"}
                </button>
                <button type="button" onClick={onPmDispatch} disabled={!canPmDispatch || pmDispatching}>
                  {pmDispatching ? "启动中…" : "PM 分配并启动"}
                </button>
              </div>
            </div>

            {pmError ? (
              <div role="alert" className="alert" style={{ marginTop: 10 }}>
                {pmError}
              </div>
            ) : null}

            {effectivePmAnalysis ? (
              <>
                <div className="kvGrid">
                  <div className="kvItem">
                    <div className="muted">风险</div>
                    {renderPmRisk(effectivePmAnalysis.risk)}
                  </div>
                  <div className="kvItem">
                    <div className="muted">来源</div>
                    <span className="muted">
                      {effectivePmMeta?.source ?? "unknown"}
                      {effectivePmMeta?.model ? ` · ${effectivePmMeta.model}` : ""}
                    </span>
                  </div>
                  <div className="kvItem">
                    <div className="muted">推荐 Role</div>
                    {recommendedRoleLabel ? (
                      <code title={recommendedRoleLabel}>{recommendedRoleLabel}</code>
                    ) : (
                      <span className="muted">无</span>
                    )}
                  </div>
                  <div className="kvItem">
                    <div className="muted">推荐 Agent</div>
                    {recommendedAgentName ? (
                      <code title={recommendedAgentName}>{recommendedAgentName}</code>
                    ) : (
                      <span className="muted">自动/无</span>
                    )}
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div className="muted">摘要</div>
                  <div className="pre">{effectivePmAnalysis.summary}</div>
                </div>

                {effectivePmAnalysis.questions?.length ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted">需要你确认</div>
                    <div className="pre">
                      {effectivePmAnalysis.questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n")}
                    </div>
                  </div>
                ) : (
                  <div className="muted" style={{ marginTop: 10 }}>
                    无需额外澄清问题
                  </div>
                )}

                {!currentRunId &&
                (effectivePmAnalysis.recommendedRoleKey || effectivePmAnalysis.recommendedAgentId) ? (
                  <div className="row gap" style={{ marginTop: 10 }}>
                    <button type="button" onClick={onPmApplyRecommendation} disabled={pmLoading || pmDispatching}>
                      应用推荐到下方手动选择
                    </button>
                    {pmFromArtifact?.createdAt ? (
                      <span className="muted">最近一次分析：{new Date(pmFromArtifact.createdAt).toLocaleString()}</span>
                    ) : null}
                  </div>
                ) : pmFromArtifact?.createdAt ? (
                  <div className="muted" style={{ marginTop: 10 }}>
                    最近一次分析：{new Date(pmFromArtifact.createdAt).toLocaleString()}
                    {pmFromArtifact.reason ? ` · ${pmFromArtifact.reason}` : ""}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="muted" style={{ marginTop: 8 }}>
                还没有 PM 分析结果：可点击“分析”，或等待自动化在后台生成。
              </div>
            )}
          </section>

          <IssueRunCard
            run={run}
            currentRunId={currentRunId}
            sessionId={sessionId}
            sessionKnown={sessionKnown}
            onRefresh={() => {
              void refresh();
            }}
            onStartRun={onStartRun}
            onCancelRun={onCancelRun}
            onCompleteRun={onCompleteRun}
            canStartRun={canStartRun}
            agents={agents}
            agentsLoaded={agentsLoaded}
            agentsError={agentsError}
            availableAgentsCount={availableAgents.length}
            currentAgent={currentAgent}
            currentAgentEnvLabel={currentAgentEnvLabel}
            currentAgentSandbox={currentAgentSandbox}
            selectedAgentId={selectedAgentId}
            onSelectedAgentIdChange={setSelectedAgentId}
            selectedAgent={selectedAgent}
            selectedAgentEnvLabel={selectedAgentEnvLabel}
            selectedAgentSandbox={selectedAgentSandbox}
            roles={roles}
            rolesLoaded={rolesLoaded}
            rolesError={rolesError}
            selectedRoleKey={selectedRoleKey}
            onSelectedRoleKeyChange={setSelectedRoleKey}
            worktreeName={worktreeName}
            onWorktreeNameChange={setWorktreeName}
          />

          <section className="card">
            <div className="row spaceBetween">
              <h2>Console</h2>
              {run?.executorType === "agent" && run?.status === "running" ? (
                <button
                  onClick={onPauseRun}
                  disabled={!currentRunId || pausing || !sessionKnown || (currentAgent ? !agentOnline : false)}
                  title={!sessionKnown ? "ACP sessionId 尚未建立/同步" : ""}
                >
                  {pausing ? "暂停中…" : "暂停 Agent"}
                </button>
              ) : null}
            </div>
            <RunConsole events={events} />
            <form onSubmit={onSendPrompt} className="consoleInput">
              <input
                aria-label="对话输入"
                value={chatText}
                onChange={(e) => setChatText(e.target.value)}
                placeholder={
                  !currentRunId
                    ? "请先启动 Run"
                    : run?.executorType !== "agent"
                      ? "当前 Run 不是 Agent 执行器"
                      : "像 CLI 一样继续对话…"
                }
                disabled={
                  !currentRunId ||
                  sending ||
                  run?.executorType !== "agent" ||
                  (currentAgent ? !agentOnline : false)
                }
              />
              <button
                type="submit"
                disabled={
                  !currentRunId ||
                  sending ||
                  !chatText.trim() ||
                  run?.executorType !== "agent" ||
                  (currentAgent ? !agentOnline : false)
                }
              >
                发送
              </button>
            </form>
            {currentRunId && run?.executorType === "agent" && currentAgent && !agentOnline ? (
              <div className="muted" style={{ marginTop: 8 }}>
                当前 Agent 离线：需要等待其重新上线，或重新启动新的 Run。
              </div>
            ) : currentRunId && run?.executorType === "agent" && !sessionKnown ? (
              <div className="muted" style={{ marginTop: 8 }}>
                ACP sessionId 还未同步到页面：proxy 会优先尝试复用/`session/load` 历史会话；仅在确实无法恢复时才会新建并注入上下文继续。
              </div>
            ) : null}
          </section>


          <section className="card">
            <details
              onToggle={(e) => {
                setChangesOpen((e.currentTarget as HTMLDetailsElement).open);
              }}
            >
              <summary className="detailsSummary">变更</summary>
              {changesOpen ? (
                <RunChangesPanel
                  runId={run?.id ?? ""}
                  run={run}
                  project={issue.project}
                  onRunUpdated={setRun}
                  onAfterAction={() => refresh({ silent: true })}
                />
              ) : (
                <div className="muted" style={{ padding: "10px 0" }}>
                  展开后加载变更与 diff
                </div>
              )}
            </details>
          </section>
          <section className="card">
            <details>
              <summary className="detailsSummary">
                交付物{run?.artifacts?.length ? ` (${run.artifacts.length})` : ""}
              </summary>
              <ArtifactList artifacts={run?.artifacts ?? []} />
            </details>
          </section>
        </>
      ) : (
        <div className="muted">Issue 不存在</div>
      )}
    </div>
  );
}
