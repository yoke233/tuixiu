import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { bootstrapAuth, loginAuth, meAuth } from "../api/auth";
import type { User, UserRole } from "../types";
import { AuthContext, type AuthState } from "./AuthContext";
import { clearStoredAuth, getStoredToken, getStoredUser, setStoredToken, setStoredUser } from "./storage";

export function AuthProvider(props: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [user, setUser] = useState<User | null>(() => (getStoredToken() ? getStoredUser() : null));
  const status: AuthState["status"] = token ? (user ? "authenticated" : "loading") : "anonymous";

  useEffect(() => {
    if (!token) return;
    if (user) return;

    let cancelled = false;
    meAuth()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStoredUser(u);
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredAuth();
        setToken(null);
        setUser(null);
      });

    return () => {
      cancelled = true;
    };
  }, [token, user]);

  const login = useCallback(async (input: { username: string; password: string }) => {
    const res = await loginAuth(input);
    setStoredToken(res.token);
    setStoredUser(res.user);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const bootstrap = useCallback(async (input: { username?: string; password?: string }) => {
    const res = await bootstrapAuth(input);
    setStoredToken(res.token);
    setStoredUser(res.user);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    clearStoredAuth();
    setToken(null);
    setUser(null);
  }, []);

  const hasRole = useCallback(
    (roles: UserRole[]) => {
      const role = user?.role;
      if (!role) return false;
      return roles.includes(role);
    },
    [user?.role],
  );

  const value = useMemo<AuthState>(
    () => ({ status, token, user, login, bootstrap, logout, hasRole }),
    [bootstrap, hasRole, login, logout, status, token, user],
  );

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}
