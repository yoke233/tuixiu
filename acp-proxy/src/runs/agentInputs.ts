import path from "node:path";

import { isRecord } from "../utils/validate.js";

export type AgentInputsTargetRoot = "WORKSPACE" | "USER_HOME";
export type AgentInputsApply = "bindMount" | "downloadExtract" | "writeFile" | "copy";
export type AgentInputsAccess = "ro" | "rw";

export type AgentInputsEnvPatch = Partial<Record<"HOME" | "USER" | "LOGNAME", string>>;

export type AgentInputItem = {
  id: string;
  apply: AgentInputsApply;
  access?: AgentInputsAccess;
  source:
    | { type: "hostPath"; path: string }
    | { type: "httpZip"; uri: string; contentHash?: string }
    | { type: "inlineText"; text: string };
  target: { root: AgentInputsTargetRoot; path: string };
};

export type AgentInputsManifest = {
  version: 1;
  envPatch?: AgentInputsEnvPatch;
  items: AgentInputItem[];
};

function assertRelativePosixPath(p: string): void {
  const raw = String(p ?? "").replaceAll("\\", "/").trim();
  if (raw === "") return;
  if (raw.startsWith("/")) throw new Error("target.path must be relative");
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === "") return;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("target.path must not escape root");
  }
}

export function parseAgentInputsFromInit(init: unknown): AgentInputsManifest | null {
  if (!isRecord(init)) return null;
  if (!("agentInputs" in init)) return null;
  const raw = (init as any).agentInputs;
  if (!isRecord(raw)) throw new Error("INVALID_AGENT_INPUTS");

  const version = Number((raw as any).version);
  if (version !== 1) throw new Error("UNSUPPORTED_AGENT_INPUTS_VERSION");

  const itemsRaw = (raw as any).items;
  if (!Array.isArray(itemsRaw)) throw new Error("INVALID_AGENT_INPUTS_ITEMS");

  let envPatch: AgentInputsEnvPatch | undefined;
  if ((raw as any).envPatch != null) {
    const patchRaw = (raw as any).envPatch;
    if (!isRecord(patchRaw)) throw new Error("INVALID_AGENT_INPUTS_ENV_PATCH");
    const allowed = new Set(["HOME", "USER", "LOGNAME"]);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(patchRaw)) {
      const key = String(k ?? "").trim();
      if (!allowed.has(key)) throw new Error(`INVALID_AGENT_INPUTS_ENV_PATCH_KEY:${key}`);
      out[key] = typeof v === "string" ? v : String(v ?? "");
    }
    envPatch = out as AgentInputsEnvPatch;
  }

  const items: AgentInputItem[] = itemsRaw.map((itemRaw, idx) => {
    if (!isRecord(itemRaw)) throw new Error(`INVALID_AGENT_INPUTS_ITEM:${idx + 1}`);

    const id = String((itemRaw as any).id ?? "").trim();
    if (!id) throw new Error(`INVALID_AGENT_INPUTS_ITEM_ID:${idx + 1}`);

    const apply = String((itemRaw as any).apply ?? "").trim() as AgentInputsApply;
    const applyAllowed = new Set<AgentInputsApply>(["bindMount", "downloadExtract", "writeFile", "copy"]);
    if (!applyAllowed.has(apply)) throw new Error(`INVALID_AGENT_INPUTS_ITEM_APPLY:${id}`);

    const accessRaw = (itemRaw as any).access;
    const access = accessRaw == null ? undefined : (String(accessRaw).trim() as AgentInputsAccess);
    if (access != null) {
      const accessAllowed = new Set<AgentInputsAccess>(["ro", "rw"]);
      if (!accessAllowed.has(access)) throw new Error(`INVALID_AGENT_INPUTS_ITEM_ACCESS:${id}`);
    }

    const targetRaw = (itemRaw as any).target;
    if (!isRecord(targetRaw)) throw new Error(`INVALID_AGENT_INPUTS_ITEM_TARGET:${id}`);
    const root = String((targetRaw as any).root ?? "").trim() as AgentInputsTargetRoot;
    const rootAllowed = new Set<AgentInputsTargetRoot>(["WORKSPACE", "USER_HOME"]);
    if (!rootAllowed.has(root)) throw new Error(`INVALID_AGENT_INPUTS_ITEM_TARGET_ROOT:${id}`);
    const targetPath = String((targetRaw as any).path ?? "").replaceAll("\\", "/").trim();
    assertRelativePosixPath(targetPath);

    const sourceRaw = (itemRaw as any).source;
    if (!isRecord(sourceRaw)) throw new Error(`INVALID_AGENT_INPUTS_ITEM_SOURCE:${id}`);
    const sourceType = String((sourceRaw as any).type ?? "").trim();

    let source: AgentInputItem["source"];
    if (sourceType === "hostPath") {
      const hostPath = String((sourceRaw as any).path ?? "").trim();
      if (!hostPath) throw new Error(`INVALID_AGENT_INPUTS_ITEM_SOURCE_HOST_PATH:${id}`);
      source = { type: "hostPath", path: hostPath };
    } else if (sourceType === "httpZip") {
      const uri = String((sourceRaw as any).uri ?? "").trim();
      if (!uri) throw new Error(`INVALID_AGENT_INPUTS_ITEM_SOURCE_URI:${id}`);
      const contentHash = typeof (sourceRaw as any).contentHash === "string" ? String((sourceRaw as any).contentHash) : undefined;
      source = { type: "httpZip", uri, ...(contentHash ? { contentHash } : {}) };
    } else if (sourceType === "inlineText") {
      const text = String((sourceRaw as any).text ?? "");
      source = { type: "inlineText", text };
    } else {
      throw new Error(`INVALID_AGENT_INPUTS_ITEM_SOURCE_TYPE:${id}`);
    }

    return {
      id,
      apply,
      ...(access ? { access } : {}),
      source,
      target: { root, path: targetPath },
    };
  });

  return { version: 1, ...(envPatch ? { envPatch } : {}), items };
}

