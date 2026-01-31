import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ThemeToggle } from "../components/ThemeToggle";
import { useAuth } from "../auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function getNextPath(search: string): string {
  try {
    const next = new URLSearchParams(search).get("next");
    return next && next.startsWith("/") ? next : "/issues";
  } catch {
    return "/issues";
  }
}

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = useMemo(() => getNextPath(location.search), [location.search]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === "authenticated") {
      navigate(nextPath, { replace: true });
    }
  }, [auth.status, navigate, nextPath]);

  async function submit(mode: "login" | "bootstrap") {
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "bootstrap") {
        await auth.bootstrap({ username: username.trim() || undefined, password: password || undefined });
      } else {
        await auth.login({ username: username.trim(), password });
      }
      navigate(nextPath, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">登录</h1>
          <div className="muted">需要登录后才能执行创建/启动/回滚等写操作</div>
        </div>
        <ThemeToggle />
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <Card>
        <CardContent className="grid gap-4 p-6">
          <div className="grid gap-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin / dev / pm / reviewer"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="至少 6 位（bootstrap）"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => submit("login")}
                disabled={submitting || auth.status === "loading" || !username.trim() || !password}
              >
                登录
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => submit("bootstrap")}
                disabled={submitting || auth.status === "loading"}
              >
                初始化管理员（首次）
              </Button>
            </div>
            <Button variant="link" size="sm" asChild>
              <Link to="/issues">返回看板</Link>
            </Button>
          </div>

          <div className="text-xs text-muted-foreground">
            “初始化管理员”仅在服务端尚未创建任何用户时可用。
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
