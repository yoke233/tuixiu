import type { User } from "../types";

const USER_KEY = "authUser";

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "string") return null;
    if (typeof parsed.username !== "string") return null;
    if (typeof parsed.role !== "string") return null;
    return parsed as User;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User | null) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    // ignore
  }
}

export function clearStoredAuth() {
  setStoredUser(null);
}
