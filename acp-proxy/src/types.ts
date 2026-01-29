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

export type AcpMessageMessage = {
  type: "acp_message";
  run_id: string;
  message: unknown;
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

export type AgentUpdateMessage = {
  type: "agent_update";
  run_id: string;
  content: unknown;
};

export type SandboxControlMessage = {
  type: "sandbox_control";
  run_id: string;
  instance_name: string;
  action: "inspect" | "ensure_running" | "stop" | "remove" | "report_inventory";
};

export type IncomingMessage =
  | AcpOpenMessage
  | AcpCloseMessage
  | AcpMessageMessage
  | PromptSendMessage
  | SandboxControlMessage
  | { type: string; [k: string]: unknown };
