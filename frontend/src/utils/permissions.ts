import type { UserRole } from "@/types";

export function canRunIssue(role: UserRole | null): boolean {
  return role === "admin" || role === "dev" || role === "pm";
}

export function canChangeIssueStatus(role: UserRole | null): boolean {
  return role === "admin" || role === "pm";
}

export function canManageTasks(role: UserRole | null): boolean {
  return role === "admin" || role === "dev";
}

export function canPauseAgent(role: UserRole | null): boolean {
  return role === "admin" || role === "dev";
}

export function canUsePmTools(role: UserRole | null): boolean {
  return role === "admin" || role === "pm";
}

