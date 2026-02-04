import type {
  AcpSessionActivity,
  AgentStatus,
  IssueStatus,
  RunStatus,
  SandboxStatus,
  StepStatus,
  TaskStatus,
} from "@/types";
import { Badge } from "@/components/ui/badge";

type Status =
  | IssueStatus
  | RunStatus
  | AgentStatus
  | TaskStatus
  | StepStatus
  | AcpSessionActivity
  | SandboxStatus;

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<string, Tone> = {
  pending: "neutral",
  ready: "info",
  running: "info",
  creating: "info",
  stopped: "neutral",
  missing: "warning",
  error: "danger",
  waiting_human: "info",
  blocked: "warning",
  reviewing: "info",
  done: "success",
  completed: "success",
  waiting_ci: "warning",
  failed: "danger",
  cancelled: "neutral",
  online: "success",
  offline: "neutral",
  degraded: "warning",
  suspended: "danger",
  unknown: "neutral",
  idle: "neutral",
  busy: "info",
  loading: "info",
  cancel_requested: "warning",
  closed: "neutral",
};

export function StatusBadge(props: { status: Status }) {
  const tone = TONES[props.status] ?? "neutral";
  if (tone === "success") {
    return (
      <Badge className="bg-success text-success-foreground hover:bg-success/80">
        {props.status}
      </Badge>
    );
  }
  if (tone === "warning") {
    return (
      <Badge className="bg-warning text-warning-foreground hover:bg-warning/80">
        {props.status}
      </Badge>
    );
  }
  if (tone === "danger") {
    return <Badge variant="destructive">{props.status}</Badge>;
  }
  if (tone === "info") {
    return <Badge className="bg-info text-info-foreground hover:bg-info/80">{props.status}</Badge>;
  }
  return <Badge variant="secondary">{props.status}</Badge>;
}
