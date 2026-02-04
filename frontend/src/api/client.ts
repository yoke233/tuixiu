import type { ApiEnvelope } from "@/types";

let refreshPromise: Promise<boolean> | null = null;

async function refreshOnce(headers: Headers): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = fetch(apiUrl("/auth/refresh"), { method: "POST", credentials: "include", headers })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}
export function getApiBaseUrl(): string {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  if (base && base.trim()) {
    return base.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined" && window.location) {
    return new URL("/api", window.location.href).toString().replace(/\/+$/, "");
  }
  return "http://localhost:3000/api";
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export async function apiRequest<T>(path: string, init?: RequestInit, retry = 0): Promise<T> {
  const url = `${getApiBaseUrl()}${path.startsWith("/") ? "" : "/"}${path}`;

  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as ApiEnvelope<T>) : null;

  const pathOnly = path.split("?")[0];
  const skipRefresh =
    pathOnly === "/auth/login" ||
    pathOnly === "/auth/bootstrap" ||
    pathOnly === "/auth/refresh" ||
    pathOnly === "/auth/logout";
  if (res.status === 401 && retry === 0 && !skipRefresh) {
    try {
      const refreshed = await refreshOnce(headers);
      if (refreshed) {
        return apiRequest<T>(path, init, retry + 1);
      }
    } catch {
      // ignore and fall through to error handling
    }
  }

  if (!res.ok) {
    const apiMsg = (() => {
      if (json && typeof json === "object") {
        if ("success" in json && (json as any).success === false) {
          return ((json as any).error?.message as string | undefined) ?? res.statusText;
        }

        // Fastify 默认错误格式：{ statusCode, error, message }
        const msg = (json as any).message;
        if (typeof msg === "string" && msg.trim()) return msg.trim();
      }

      return res.statusText;
    })();
    const err = new Error(`HTTP ${res.status}: ${apiMsg}`) as any;
    if (json && typeof json === "object" && (json as any)?.error?.details != null) {
      err.details = (json as any).error.details;
    }
    throw err;
  }

  if (!json || typeof json !== "object") {
    throw new Error("响应不是 JSON");
  }

  if (json.success === false) {
    const err = new Error(json.error.message) as any;
    if ((json as any)?.error?.details != null) err.details = (json as any).error.details;
    throw err;
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
