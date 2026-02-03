import { apiGet, apiPost, apiRequest } from "./client";
import type { User } from "../types";

export type AuthResponse = { user: User };
export type AuthBootstrapInput = { username?: string; password?: string; bootstrapToken?: string };

function isUser(value: unknown): value is User {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as any;
  return typeof v.id === "string" && typeof v.username === "string" && typeof v.role === "string";
}

export async function bootstrapAuth(input: AuthBootstrapInput): Promise<AuthResponse> {
  const headers = new Headers();
  if (input.bootstrapToken && input.bootstrapToken.trim()) {
    headers.set("x-bootstrap-token", input.bootstrapToken.trim());
  }
  const data = await apiRequest<{ user: User }>("/auth/bootstrap", {
    method: "POST",
    headers,
    body: JSON.stringify({ username: input.username, password: input.password }),
  });
  if (!data || typeof data !== "object") throw new Error("响应不合法");
  const user = (data as any).user;
  if (!isUser(user)) throw new Error("响应不合法");
  return { user };
}

export async function loginAuth(input: { username: string; password: string }): Promise<AuthResponse> {
  const data = await apiPost<{ user: User }>("/auth/login", input);
  if (!data || typeof data !== "object") throw new Error("响应不合法");
  const user = (data as any).user;
  if (!isUser(user)) throw new Error("响应不合法");
  return { user };
}

export async function meAuth(): Promise<User> {
  const data = await apiGet<{ user: User }>("/auth/me");
  const user = (data as any)?.user;
  if (!isUser(user)) throw new Error("响应不合法");
  return user;
}

export async function logoutAuth(): Promise<void> {
  await apiPost("/auth/logout", {});
}

export async function refreshAuth(): Promise<void> {
  await apiPost("/auth/refresh", {});
}
