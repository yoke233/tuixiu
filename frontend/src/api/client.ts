import type { ApiEnvelope } from "../types";
import { getStoredToken } from "../auth/storage";

export function getApiBaseUrl(): string {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  return (base ?? "http://localhost:3000/api").replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${getApiBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`;
  const token = getStoredToken();

  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {})
    }
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;

  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "success" in json && (json as any).success === false
        ? (json as any).error?.message ?? res.statusText
        : res.statusText;
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  if (!json || typeof json !== "object") {
    throw new Error("响应不是 JSON");
  }

  if (json.success === false) {
    throw new Error(json.error.message);
  }

  return json.data;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiRequest<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: "PUT", body: JSON.stringify(body) });
}
