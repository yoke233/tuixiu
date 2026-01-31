import type { Agent, RoleTemplate, Run } from "../types";
import { getAgentSandboxLabel } from "../utils/agentLabels";
import { StatusBadge } from "./StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SandboxLabel = { label: string; details?: string } | null;

type IssueRunCardProps = {
  run: Run | null;
  currentRunId: string;
  sessionId: string | null;
  sessionKnown: boolean;

  refreshing: boolean;
  cancellingRun: boolean;
  completingRun: boolean;

  onRefresh: () => void;
  onStartRun: () => void;
  onCancelRun: () => void;
  onCompleteRun: () => void;

  canStartRun: boolean;
  canManageRun: boolean;

  agents: Agent[];
  agentsLoaded: boolean;
  agentsError: string | null;
  availableAgentsCount: number;

  currentAgent: Agent | null;
  currentAgentEnvLabel: string | null;
  currentAgentSandbox: SandboxLabel;

  selectedAgentId: string;
  onSelectedAgentIdChange: (agentId: string) => void;
  selectedAgent: Agent | null;
  selectedAgentEnvLabel: string | null;
  selectedAgentSandbox: SandboxLabel;

  roles: RoleTemplate[];
  rolesLoaded: boolean;
  rolesError: string | null;
  selectedRoleKey: string;
  onSelectedRoleKeyChange: (roleKey: string) => void;

  worktreeName: string;
  onWorktreeNameChange: (name: string) => void;
};

export function IssueRunCard(props: IssueRunCardProps) {
  const {
    run,
    currentRunId,
    sessionId,
    sessionKnown,
    refreshing,
    cancellingRun,
    completingRun,
    onRefresh,
    onStartRun,
    onCancelRun,
    onCompleteRun,
    canStartRun,
    canManageRun,
    agents,
    agentsLoaded,
    agentsError,
    availableAgentsCount,
    currentAgent,
    currentAgentEnvLabel,
    currentAgentSandbox,
    selectedAgentId,
    onSelectedAgentIdChange,
    selectedAgent,
    selectedAgentEnvLabel,
    selectedAgentSandbox,
    roles,
    rolesLoaded,
    rolesError,
    selectedRoleKey,
    onSelectedRoleKeyChange,
    worktreeName,
    onWorktreeNameChange
  } = props;

  const runStatus = run?.status ?? null;
  const canOperateRunningRun = runStatus === "pending" || runStatus === "running" || runStatus === "waiting_ci";
  const canStartNewRun = !run || runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled";
  const roleSelectValue = selectedRoleKey ? selectedRoleKey : "__project_default__";
  const agentSelectValue = selectedAgentId ? selectedAgentId : "__auto_assign__";

  return (
    <section className="card">
      <div className="row spaceBetween">
        <h2>Run</h2>
        <div className="row gap">
          <Button type="button" size="sm" variant="secondary" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "刷新"}
          </Button>

          {canStartNewRun ? (
            <Button
              type="button"
              onClick={onStartRun}
              disabled={!canStartRun || refreshing}
              title={!canStartRun ? "当前账号无权限启动 Run，或当前无可用 Agent" : ""}
            >
              {run ? "启动新 Run" : "启动 Run"}
            </Button>
          ) : canOperateRunningRun ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onCancelRun}
                disabled={!currentRunId || !canManageRun || cancellingRun || completingRun}
                title={!canManageRun ? "当前账号无权限操作 Run" : ""}
              >
                {cancellingRun ? "取消中…" : "取消 Run"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={onCompleteRun}
                disabled={!currentRunId || !canManageRun || cancellingRun || completingRun}
                title={!canManageRun ? "当前账号无权限操作 Run" : ""}
              >
                {completingRun ? "完成中…" : "完成 Run"}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {canStartNewRun && agentsLoaded && !agentsError && availableAgentsCount === 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          当前没有可用的在线 Agent：请先启动 `acp-proxy`（或等待 Agent 空闲）。
        </div>
      ) : null}

      {canStartNewRun && agentsError ? (
        <div className="muted" style={{ marginTop: 8 }} title={agentsError}>
          无法获取 Agent 列表：仍可尝试启动 Run（将由后端自动分配；如无 Agent 会返回错误）。
        </div>
      ) : null}

      {run ? (
        <dl className="kvTable">
          <dt>runId</dt>
          <dd>
            <code title={run.id}>{run.id}</code>
          </dd>

          <dt>status</dt>
          <dd>
            <StatusBadge status={run.status} />
          </dd>

          <dt>executor</dt>
          <dd>
            <code>{run.executorType}</code>
          </dd>

          <dt>branch</dt>
          <dd>{run.branchName ? <code title={run.branchName}>{run.branchName}</code> : <span className="muted">未知</span>}</dd>

          <dt>worktree</dt>
          <dd>{run.workspacePath ? <code title={run.workspacePath}>{run.workspacePath}</code> : <span className="muted">未知</span>}</dd>

          <dt>agentId</dt>
          <dd>{run.agentId ? <code title={run.agentId}>{run.agentId}</code> : <span className="muted">—</span>}</dd>

          <dt>agent</dt>
          <dd>
            <span className="row gap" style={{ alignItems: "center", flexWrap: "wrap" }}>
              {currentAgent ? (
                <>
                  <StatusBadge status={currentAgent.status} />
                  <span className="muted">{currentAgent.name}</span>
                </>
              ) : (
                <span className="muted">未知</span>
              )}
              {currentAgent ? (
                <span className="muted">
                  {currentAgent.currentLoad}/{currentAgent.maxConcurrentRuns}
                </span>
              ) : null}
            </span>
          </dd>

          <dt>环境</dt>
          <dd>
            <span className="muted">{currentAgentEnvLabel ?? "未知"}</span>
          </dd>

          <dt>sandbox</dt>
          <dd>
            {currentAgentSandbox ? (
              <span className="muted" title={currentAgentSandbox.details ?? ""}>
                {currentAgentSandbox.label}
              </span>
            ) : (
              <span className="muted">未知</span>
            )}
          </dd>

          <dt>session</dt>
          <dd>{sessionKnown ? <code title={sessionId ?? ""}>{sessionId}</code> : <span className="muted">未建立</span>}</dd>
        </dl>
      ) : null}

      {canStartNewRun ? (
        <div className="mt-3 grid gap-3">
          <div className="grid gap-2">
            <Label>Worktree 名称（可选）</Label>
            <Input
              value={worktreeName}
              onChange={(e) => onWorktreeNameChange(e.target.value)}
              placeholder="留空则自动生成（如 gh-123-fix-login-r1）"
              disabled={refreshing}
            />
            <div className="text-xs text-muted-foreground">
              将用于：分支 <code>run/&lt;name&gt;</code>，目录 <code>.worktrees/run-&lt;name&gt;</code>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>选择 Role（可选）</Label>
              <Select
                value={roleSelectValue}
                onValueChange={(v) =>
                  onSelectedRoleKeyChange(v === "__project_default__" ? "" : v)
                }
                disabled={(!rolesLoaded && !rolesError) || refreshing}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="项目默认" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__project_default__">项目默认</SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.key}>
                      {r.displayName} ({r.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">不选则使用 Project 默认</div>
            </div>

            <div className="grid gap-2">
              <Label>选择 Agent（可选）</Label>
              <Select
                value={agentSelectValue}
                onValueChange={(v) => onSelectedAgentIdChange(v === "__auto_assign__" ? "" : v)}
                disabled={refreshing}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="自动分配" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto_assign__">自动分配</SelectItem>
                  {agents.map((a) => {
                    const sandbox = getAgentSandboxLabel(a);
                    const disabled = a.status !== "online" || a.currentLoad >= a.maxConcurrentRuns;
                    return (
                      <SelectItem key={a.id} value={a.id} disabled={disabled}>
                        {a.name} ({a.status} {a.currentLoad}/{a.maxConcurrentRuns}
                        {sandbox?.label ? ` · ${sandbox.label}` : ""})
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">不选则自动分配（仅 online）</div>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {run ? "可启动新 Run" : "暂无 Run"}
            {selectedAgent ? (
              <span>
                {" · "}
                {selectedAgentEnvLabel ?? "未知"}
                {selectedAgentSandbox?.label ? ` · ${selectedAgentSandbox.label}` : ""}
              </span>
            ) : null}
            {rolesError ? <span>{" · "}Role 加载失败</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
