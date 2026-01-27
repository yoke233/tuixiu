import type { Agent, RoleTemplate, Run } from "../types";
import { getAgentSandboxLabel } from "../utils/agentLabels";
import { StatusBadge } from "./StatusBadge";

type SandboxLabel = { label: string; details?: string } | null;

type IssueRunCardProps = {
  run: Run | null;
  currentRunId: string;
  sessionId: string | null;
  sessionKnown: boolean;

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

  return (
    <section className="card">
      <div className="row spaceBetween">
        <h2>Run</h2>
        <div className="row gap">
          <button onClick={onRefresh}>刷新</button>
          {currentRunId ? (
            <>
              <button onClick={onCancelRun} disabled={!currentRunId || !canManageRun} title={!canManageRun ? "当前账号无权限操作 Run" : ""}>
                取消 Run
              </button>
              <button onClick={onCompleteRun} disabled={!currentRunId || !canManageRun} title={!canManageRun ? "当前账号无权限操作 Run" : ""}>
                完成 Run
              </button>
            </>
          ) : (
            <button onClick={onStartRun} disabled={!canStartRun}>
              启动 Run
            </button>
          )}
        </div>
      </div>

      {!run && agentsLoaded && !agentsError && availableAgentsCount === 0 ? (
        <div className="muted" style={{ marginTop: 8 }}>
          当前没有可用的在线 Agent：请先启动 `acp-proxy`（或等待 Agent 空闲）。
        </div>
      ) : null}

      {!run && agentsError ? (
        <div className="muted" style={{ marginTop: 8 }} title={agentsError}>
          无法获取 Agent 列表：仍可尝试启动 Run（将由后端自动分配；如无 Agent 会返回错误）。
        </div>
      ) : null}

      {run ? (
        <div className="kvGrid">
          <div className="kvItem">
            <div className="muted">runId</div>
            <code title={run.id}>{run.id}</code>
          </div>
          <div className="kvItem">
            <div className="muted">status</div>
            <StatusBadge status={run.status} />
          </div>
          <div className="kvItem">
            <div className="muted">executor</div>
            <code>{run.executorType}</code>
          </div>
          <div className="kvItem">
            <div className="muted">branch</div>
            {run.branchName ? <code title={run.branchName}>{run.branchName}</code> : <span className="muted">未知</span>}
          </div>
          <div className="kvItem">
            <div className="muted">worktree</div>
            {run.workspacePath ? (
              <code title={run.workspacePath}>{run.workspacePath}</code>
            ) : (
              <span className="muted">未知</span>
            )}
          </div>
          <div className="kvItem">
            <div className="muted">agentId</div>
            {run.agentId ? <code title={run.agentId}>{run.agentId}</code> : <span className="muted">—</span>}
          </div>
          <div className="kvItem">
            <div className="muted">agent</div>
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
          </div>
          <div className="kvItem">
            <div className="muted">环境</div>
            <span className="muted">{currentAgentEnvLabel ?? "未知"}</span>
          </div>
          <div className="kvItem">
            <div className="muted">sandbox</div>
            {currentAgentSandbox ? (
              <span className="muted" title={currentAgentSandbox.details ?? ""}>
                {currentAgentSandbox.label}
              </span>
            ) : (
              <span className="muted">未知</span>
            )}
          </div>
          <div className="kvItem">
            <div className="muted">session</div>
            {sessionKnown ? <code title={sessionId ?? ""}>{sessionId}</code> : <span className="muted">未建立</span>}
          </div>
        </div>
      ) : (
        <div className="row gap">
          <label className="label" style={{ margin: 0, flex: "1 1 240px", minWidth: 0 }}>
            Worktree 名称（可选）
            <input
              value={worktreeName}
              onChange={(e) => onWorktreeNameChange(e.target.value)}
              placeholder="留空则自动生成（如 gh-123-fix-login-r1）"
            />
            <div className="muted" style={{ fontSize: 12 }}>
              将用于：分支 `run/&lt;name&gt;`，目录 `.worktrees/run-&lt;name&gt;`
            </div>
          </label>
          <label className="label" style={{ margin: 0 }}>
            选择 Role（可选）
            <select
              value={selectedRoleKey}
              onChange={(e) => onSelectedRoleKeyChange(e.target.value)}
              disabled={!rolesLoaded && !rolesError}
            >
              <option value="">项目默认</option>
              {roles.map((r) => (
                <option key={r.id} value={r.key}>
                  {r.displayName} ({r.key})
                </option>
              ))}
            </select>
          </label>
          <label className="label" style={{ margin: 0 }}>
            选择 Agent（可选）
            <select value={selectedAgentId} onChange={(e) => onSelectedAgentIdChange(e.target.value)}>
              <option value="">自动分配</option>
              {agents.map((a) => {
                const sandbox = getAgentSandboxLabel(a);
                const disabled = a.status !== "online" || a.currentLoad >= a.maxConcurrentRuns;
                return (
                  <option key={a.id} value={a.id} disabled={disabled}>
                    {a.name} ({a.status} {a.currentLoad}/{a.maxConcurrentRuns}
                    {sandbox?.label ? ` · ${sandbox.label}` : ""})
                  </option>
                );
              })}
            </select>
          </label>
          <div className="muted">
            暂无 Run
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
      )}
    </section>
  );
}
