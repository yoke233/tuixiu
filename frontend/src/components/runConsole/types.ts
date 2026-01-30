export type ConsoleRole = "user" | "agent" | "system";
export type ConsoleKind = "chunk" | "block";

export type ToolCallInfo = {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  cwd?: string;
  command?: string;
  exitCode?: number;
  output?: string;
  stderr?: string;
};

export type PermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

export type ConsoleItem = {
  id: string;
  role: ConsoleRole;
  kind: ConsoleKind;
  text: string;
  timestamp: string;
  live?: boolean;
  toolCallId?: string;
  toolCallInfo?: ToolCallInfo;
  permissionRequest?: {
    requestId: string;
    sessionId: string;
    promptId: string | null;
    toolCall?: unknown;
    options: PermissionOption[];
  };
  detailsTitle?: string;
  chunkType?: "agent_message" | "agent_thought" | "user_message";
  initStep?: {
    stage: string;
    status: string;
    message?: string;
  };
  plan?: {
    entries: Array<{
      status: string;
      content: string;
      priority?: string;
    }>;
  };
};
