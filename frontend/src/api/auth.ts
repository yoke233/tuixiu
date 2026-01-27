import { apiGet, apiPost } from "./client";
import type { User } from "../types";

export type AuthResponse = { token: string; user: User };

export async function bootstrapAuth(input: { username?: string; password?: string }): Promise<AuthResponse> {
  const data = await apiPost<{ token: string; user: User }>("/auth/bootstrap", input);
  return data;
}

export async function loginAuth(input: { username: string; password: string }): Promise<AuthResponse> {
  const data = await apiPost<{ token: string; user: User }>("/auth/login", input);
  return data;
}

export async function meAuth(): Promise<User> {
  const data = await apiGet<{ user: User }>("/auth/me");
  return data.user;
}

