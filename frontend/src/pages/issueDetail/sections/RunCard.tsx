import { IssueRunCard } from "../../../components/IssueRunCard";
import type { IssueDetailController } from "../useIssueDetailController";

export function RunCard(props: { model: IssueDetailController }) {
  const {
    allowRunActions,
    agents,
    agentsError,
    agentsLoaded,
    availableAgents,
    canStartRun,
    cancellingRun,
    completingRun,
    currentAgent,
    currentAgentEnvLabel,
    currentAgentSandbox,
    currentRunId,
    refresh,
    refreshing,
    onCancelRun,
    onCompleteRun,
    onStartRun,
    roles,
    rolesError,
    rolesLoaded,
    run,
    selectedAgent,
    selectedAgentEnvLabel,
    selectedAgentId,
    selectedAgentSandbox,
    selectedRoleKey,
    sessionId,
    sessionKnown,
    setSelectedAgentId,
    setSelectedRoleKey,
    setWorktreeName,
    worktreeName,
  } = props.model;

  return (
    <IssueRunCard
      run={run}
      currentRunId={currentRunId}
      sessionId={sessionId}
      sessionKnown={sessionKnown}
      refreshing={refreshing}
      cancellingRun={cancellingRun}
      completingRun={completingRun}
      onRefresh={() => {
        void refresh();
      }}
      onStartRun={onStartRun}
      onCancelRun={onCancelRun}
      onCompleteRun={onCompleteRun}
      canStartRun={canStartRun}
      canManageRun={allowRunActions}
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
  );
}

