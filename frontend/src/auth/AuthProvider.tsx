import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { bootstrapAuth, loginAuth, logoutAuth, meAuth } from "../api/auth";
import type { User, UserRole } from "../types";
import { AuthContext, type AuthState } from "./AuthContext";
import { clearStoredAuth, getStoredToken, getStoredUser, setStoredToken, setStoredUser } from "./storage";

function parseHttpStatusFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^HTTP\s+(\d+):/.exec(msg);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function AuthProvider(props: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getStoredUser());
  const [token, setToken] = useState<string | null>(() => getStoredToken());
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
      .catch((err) => {
        if (cancelled) return;
        const httpStatus = parseHttpStatusFromError(err);
        const hadStoredAuth = Boolean(getStoredUser()) || Boolean(getStoredToken());

        // 401/403 视为 token/cookie 已失效：清理并进入匿名状态。
        if (httpStatus === 401 || httpStatus === 403 || !hadStoredAuth) {
          clearStoredAuth();
          setUser(null);
          setToken(null);
          setStatus("anonymous");
          return;
        }

        // 其他错误（网络/临时故障）：保留本地登录态，避免“瞬间被登出”。
        setStatus((prev) => (prev === "loading" ? "authenticated" : prev));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (input: { username: string; password: string }) => {
    const res = await loginAuth(input);
    setStoredUser(res.user);
    setStoredToken(res.token);
    setUser(res.user);
    setToken(res.token);
    setStatus("authenticated");
  }, []);

  const bootstrap = useCallback(async (input: { username?: string; password?: string }) => {
    const res = await bootstrapAuth(input);
    setStoredUser(res.user);
    setStoredToken(res.token);
    setUser(res.user);
    setToken(res.token);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(() => {
    void logoutAuth().catch(() => {});
    clearStoredAuth();
    setUser(null);
    setToken(null);
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
    () => ({ status, token, user, login, bootstrap, logout, hasRole }),
    [bootstrap, hasRole, login, logout, status, token, user],
  );

  return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}
