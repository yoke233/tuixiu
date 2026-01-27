import type { AgentStatus, IssueStatus, RunStatus, StepStatus, TaskStatus } from "../types";

type Status = IssueStatus | RunStatus | AgentStatus | TaskStatus | StepStatus;

const COLORS: Record<string, string> = {
  pending: "badge gray",
  ready: "badge blue",
  running: "badge blue",
  waiting_human: "badge purple",
  blocked: "badge orange",
  reviewing: "badge purple",
  done: "badge green",
  completed: "badge green",
  waiting_ci: "badge orange",
  failed: "badge red",
  cancelled: "badge gray",
  online: "badge green",
  offline: "badge gray",
  degraded: "badge orange",
  suspended: "badge red"
};

export function StatusBadge(props: { status: Status }) {
  const cls = COLORS[props.status] ?? "badge gray";
  return <span className={cls}>{props.status}</span>;
}
