import { isRecord } from "../utils/validate.js";
import type {
  AcpCloseMessage,
  AcpOpenMessage,
  PromptSendMessage,
  SandboxControlMessage,
  SessionCancelMessage,
  SessionPermissionMessage,
  SessionSetModeMessage,
  SessionSetModelMessage,
} from "../types.js";

type ParseError = { error: string };

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && !!v.trim();
}

function parseInit(
  raw: unknown,
): { script: string; timeout_seconds?: number; env?: Record<string, string>; agentInputs?: unknown } | ParseError {
  if (!isRecord(raw)) return { error: "init must be object" };
  if (typeof raw.script !== "string") return { error: "init.script must be string" };

  const timeoutSecondsRaw = raw.timeout_seconds;
  if (timeoutSecondsRaw != null && !(typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw))) {
    return { error: "init.timeout_seconds must be number" };
  }

  const envRaw = raw.env;
  if (envRaw != null && !isRecord(envRaw)) return { error: "init.env must be object" };

  return raw as any;
}

export function parseAcpOpen(msg: unknown): AcpOpenMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "acp_open") return { error: "not acp_open" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (msg.init != null) {
    const init = parseInit(msg.init);
    if ("error" in init) return init;
  }
  return msg as AcpOpenMessage;
}

export function parseAcpClose(msg: unknown): AcpCloseMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "acp_close") return { error: "not acp_close" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  return msg as AcpCloseMessage;
}

export function parsePromptSend(msg: unknown): PromptSendMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "prompt_send") return { error: "not prompt_send" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString(msg.prompt_id)) return { error: "prompt_id missing" };
  if (!Array.isArray((msg as any).prompt)) return { error: "prompt must be array" };
  if ((msg as any).init != null) {
    const init = parseInit((msg as any).init);
    if ("error" in init) return init;
  }
  return msg as PromptSendMessage;
}

export function parseSessionCancel(msg: unknown): SessionCancelMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "session_cancel") return { error: "not session_cancel" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString((msg as any).control_id)) return { error: "control_id missing" };
  if (!isNonEmptyString((msg as any).session_id)) return { error: "session_id missing" };
  return msg as SessionCancelMessage;
}

export function parseSessionSetMode(msg: unknown): SessionSetModeMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "session_set_mode") return { error: "not session_set_mode" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString((msg as any).control_id)) return { error: "control_id missing" };
  if (!isNonEmptyString((msg as any).session_id)) return { error: "session_id missing" };
  if (!isNonEmptyString((msg as any).mode_id)) return { error: "mode_id missing" };
  return msg as SessionSetModeMessage;
}

export function parseSessionSetModel(msg: unknown): SessionSetModelMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "session_set_model") return { error: "not session_set_model" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString((msg as any).control_id)) return { error: "control_id missing" };
  if (!isNonEmptyString((msg as any).session_id)) return { error: "session_id missing" };
  if (!isNonEmptyString((msg as any).model_id)) return { error: "model_id missing" };
  return msg as SessionSetModelMessage;
}

export function parseSessionSetConfigOption(
  msg: unknown,
): { type: "session_set_config_option"; run_id: string; control_id: string; session_id: string; config_id: string; value: unknown } | ParseError {
  if (!isRecord(msg) || msg.type !== "session_set_config_option") return { error: "not session_set_config_option" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString((msg as any).control_id)) return { error: "control_id missing" };
  if (!isNonEmptyString((msg as any).session_id)) return { error: "session_id missing" };
  if (!isNonEmptyString((msg as any).config_id)) return { error: "config_id missing" };
  return msg as any;
}

export function parseSessionPermission(msg: unknown): SessionPermissionMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "session_permission") return { error: "not session_permission" };
  if (!isNonEmptyString(msg.run_id)) return { error: "run_id missing" };
  if (!isNonEmptyString((msg as any).session_id)) return { error: "session_id missing" };
  const requestId = (msg as any).request_id;
  if (!(typeof requestId === "string" || typeof requestId === "number")) return { error: "request_id missing" };
  const outcome = (msg as any).outcome;
  if (outcome !== "selected" && outcome !== "cancelled") return { error: "outcome invalid" };
  return msg as SessionPermissionMessage;
}

export function parseSandboxControl(msg: unknown): SandboxControlMessage | ParseError {
  if (!isRecord(msg) || msg.type !== "sandbox_control") return { error: "not sandbox_control" };
  const action = (msg as any).action;
  const allowed = new Set([
    "inspect",
    "ensure_running",
    "stop",
    "remove",
    "prune_orphans",
    "gc",
    "remove_workspace",
    "report_inventory",
    "remove_image",
    "git_push",
  ]);
  if (typeof action !== "string" || !allowed.has(action)) return { error: "action invalid" };
  return msg as SandboxControlMessage;
}

