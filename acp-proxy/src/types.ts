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

export type ExecuteTaskMessage = {
  type: "execute_task";
  run_id: string;
  session_id?: string;
  prompt: string;
  cwd?: string;
  init?: {
    script: string;
    timeout_seconds?: number;
    env?: Record<string, string>;
  };
};

export type PromptRunMessage = {
  type: "prompt_run";
  run_id: string;
  session_id?: string;
  prompt: string;
  context?: string;
  cwd?: string;
};

export type CancelTaskMessage = {
  type: "cancel_task";
  run_id: string;
  session_id?: string;
};

export type SessionCancelMessage = {
  type: "session_cancel";
  run_id: string;
  session_id?: string;
};

export type AgentUpdateMessage = {
  type: "agent_update";
  run_id: string;
  content: unknown;
};

export type IncomingMessage =
  | ExecuteTaskMessage
  | PromptRunMessage
  | CancelTaskMessage
  | SessionCancelMessage
  | { type: string; [k: string]: unknown };
