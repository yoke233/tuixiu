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

export type ConsoleItem = {
  id: string;
  role: ConsoleRole;
  kind: ConsoleKind;
  text: string;
  timestamp: string;
  toolCallId?: string;
  toolCallInfo?: ToolCallInfo;
  detailsTitle?: string;
  chunkType?: "agent_message" | "agent_thought" | "user_message";
  plan?: {
    entries: Array<{
      status: string;
      content: string;
      priority?: string;
    }>;
  };
};

