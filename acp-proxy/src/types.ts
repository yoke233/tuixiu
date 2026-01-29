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

export type AgentUpdateMessage = {
  type: "agent_update";
  run_id: string;
  content: unknown;
};

export type SandboxControlMessage = {
  type: "sandbox_control";
  run_id?: string;
  instance_name?: string;
  action: "inspect" | "ensure_running" | "stop" | "remove" | "report_inventory" | "remove_image";
  image?: string;
  expected_instances?: Array<{ instance_name: string; run_id: string }>;
};

export type IncomingMessage =
  | AcpOpenMessage
  | AcpCloseMessage
  | PromptSendMessage
  | SessionCancelMessage
  | SessionSetModeMessage
  | SessionSetModelMessage
  | SandboxControlMessage
  | { type: string; [k: string]: unknown };
