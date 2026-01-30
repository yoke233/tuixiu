import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { bootstrapAuth, loginAuth, logoutAuth, meAuth } from "../api/auth";
import type { User, UserRole } from "../types";
import { AuthContext, type AuthState } from "./AuthContext";
import { clearStoredAuth, getStoredUser, setStoredUser } from "./storage";

export function AuthProvider(props: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  useEffect(() => {
    let cancelled = false;
    meAuth()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStoredUser(u);
        setStatus("authenticated");
      })
      .catch(() => {
        if (cancelled) return;
        clearStoredAuth();
        setUser(null);
        setStatus("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: { username: string; password: string }) => {
    const res = await loginAuth(input);
    setStoredUser(res.user);
    setUser(res.user);
    setStatus("authenticated");
  }, []);

  const bootstrap = useCallback(async (input: { username?: string; password?: string }) => {
    const res = await bootstrapAuth(input);
    setStoredUser(res.user);
    setUser(res.user);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(() => {
    void logoutAuth().catch(() => {});
    clearStoredAuth();
    setUser(null);
    setStatus("anonymous");
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
    () => ({ status, token: null, user, login, bootstrap, logout, hasRole }),
    [bootstrap, hasRole, login, logout, status, user],
  );

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}
