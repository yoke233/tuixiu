import { createContext, useContext } from "react";

import type { User, UserRole } from "../types";

export type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  token: string | null;
  user: User | null;
  login: (input: { username: string; password: string }) => Promise<void>;
  bootstrap: (input: { username?: string; password?: string }) => Promise<void>;
  logout: () => void;
  hasRole: (roles: UserRole[]) => boolean;
};

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    return {
      status: "anonymous",
      token: null,
      user: null,
      login: async () => {},
      bootstrap: async () => {},
      logout: () => {},
      hasRole: () => false,
    };
  }
  return ctx;
}

