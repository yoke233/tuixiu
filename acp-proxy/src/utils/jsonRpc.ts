import type { JsonRpcRequest } from "../acpClientFacade.js";

import { isRecord } from "./validate.js";

type JsonRpcError = { code: number; message: string; data?: unknown };

export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  return (
    isRecord(v) &&
    v.jsonrpc === "2.0" &&
    typeof v.method === "string" &&
    (typeof (v as any).id === "string" || typeof (v as any).id === "number")
  );
}

export function isJsonRpcResponse(v: unknown): v is {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
} {
  if (!isRecord(v) || v.jsonrpc !== "2.0") return false;
  const id = (v as any).id;
  if (!(typeof id === "string" || typeof id === "number")) return false;
  return "result" in v || "error" in v;
}

export function isJsonRpcNotification(v: unknown): v is {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
} {
  if (!isRecord(v) || v.jsonrpc !== "2.0") return false;
  if (typeof (v as any).method !== "string") return false;
  const id = (v as any).id;
  return id === undefined || id === null;
}
