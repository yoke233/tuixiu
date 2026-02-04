export type RegisterAgentMessage = {
  type: "register_agent";
  agent: {
    id: string;
    name: string;
    capabilities?: unknown;
    max_concurrent?: number;
  };
};

export type HeartbeatMessage = {
  type: "heartbeat";
  agent_id: string;
  timestamp?: string;
};

export type AcpOpenMessage = {
  type: "acp_open";
  run_id: string;
  cwd?: string;
  instance_name?: string;
  keepalive_ttl_seconds?: number;
  init?: {
    script: string;
    timeout_seconds?: number;
    env?: Record<string, string>;
    agentInputs?: unknown;
  };
};

export type AcpCloseMessage = {
  type: "acp_close";
  run_id: string;
};

export type PromptSendMessage = {
  type: "prompt_send";
  run_id: string;
  prompt_id: string;
  cwd?: string;
  session_id?: string | null;
  context?: string;
  prompt: unknown[];
  timeout_ms?: number;
  init?: {
    script: string;
    timeout_seconds?: number;
    env?: Record<string, string>;
    agentInputs?: unknown;
  };
};

export type SessionCancelMessage = {
  type: "session_cancel";
  run_id: string;
  control_id: string;
  session_id: string;
};

export type SessionSetModeMessage = {
  type: "session_set_mode";
  run_id: string;
  control_id: string;
  session_id: string;
  mode_id: string;
};

export type SessionSetModelMessage = {
  type: "session_set_model";
  run_id: string;
  control_id: string;
  session_id: string;
  model_id: string;
};

export type SessionPermissionMessage = {
  type: "session_permission";
  run_id: string;
  session_id: string;
  request_id: string | number;
  outcome: "selected" | "cancelled";
  option_id?: string;
};

export type ProxyUpdateMessage = {
  type: "proxy_update";
  run_id: string;
  content: unknown;
};

export type SandboxControlMessage = {
  type: "sandbox_control";
  run_id?: string;
  instance_name?: string;
  action:
    | "inspect"
    | "ensure_running"
    | "stop"
    | "remove"
    | "prune_orphans"
    | "gc"
    | "remove_workspace"
    | "report_inventory"
    | "remove_image"
    | "git_push";
  image?: string;
  expected_instances?: Array<{ instance_name: string; run_id: string | null }>;
  dry_run?: boolean;
  gc?: {
    remove_orphans?: boolean;
    remove_workspaces?: boolean;
    max_delete_count?: number;
  };
  request_id?: string;
  branch?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout_seconds?: number;
  remote?: string;
};

export type SandboxInventoryMessage = {
  type: "sandbox_inventory";
  inventory_id: string;
  captured_at?: string;
  provider?: string;
  runtime?: string;
  instances?: Array<{ instance_name: string; run_id?: string | null; status?: string }>;
  missing_instances?: Array<{ instance_name: string; run_id?: string | null }>;
  deleted_instances?: Array<{
    instance_name: string;
    run_id?: string | null;
    deleted_at?: string;
    reason?: string;
  }>;
  deleted_workspaces?: Array<{
    instance_name?: string | null;
    run_id?: string | null;
    workspace_mode?: string | null;
    deleted_at?: string;
    reason?: string;
  }>;
};

export type IncomingMessage =
  | AcpOpenMessage
  | AcpCloseMessage
  | PromptSendMessage
  | SessionCancelMessage
  | SessionSetModeMessage
  | SessionSetModelMessage
  | SessionPermissionMessage
  | SandboxControlMessage
  | { type: string; [k: string]: unknown };
