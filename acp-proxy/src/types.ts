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

export type AgentUpdateMessage = {
  type: "agent_update";
  run_id: string;
  content: unknown;
};

export type IncomingMessage =
  | AcpOpenMessage
  | AcpCloseMessage
  | AcpMessageMessage
  | { type: string; [k: string]: unknown };
