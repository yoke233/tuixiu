import type { IssueStatus, RunStatus } from "../types";

type Status = IssueStatus | RunStatus;

const COLORS: Record<string, string> = {
  pending: "badge gray",
  running: "badge blue",
  reviewing: "badge purple",
  done: "badge green",
  completed: "badge green",
  waiting_ci: "badge orange",
  failed: "badge red",
  cancelled: "badge gray"
};

export function StatusBadge(props: { status: Status }) {
  const cls = COLORS[props.status] ?? "badge gray";
  return <span className={cls}>{props.status}</span>;
}

