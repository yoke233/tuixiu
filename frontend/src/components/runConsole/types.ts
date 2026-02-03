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
  // 当为 true 时，表示该条目属于“状态/调试类信息”，默认不展示（避免 Console 太吵），
  // 是否展示由上层页面的 `showStatusEvents` 开关控制。
  isStatus?: boolean;
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
