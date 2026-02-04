import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlobalErrorToast } from "@/components/GlobalErrorToast";

function getNextPath(search: string): string {
  try {
    const next = new URLSearchParams(search).get("next");
    return next && next.startsWith("/") ? next : "/issues";
  } catch {
    return "/issues";
  }
}

export function BootstrapPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = useMemo(() => getNextPath(location.search), [location.search]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === "authenticated") {
      navigate(nextPath, { replace: true });
    }
  }, [auth.status, navigate, nextPath]);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await auth.bootstrap({
        username: username.trim() || undefined,
        password: password || undefined,
        bootstrapToken: bootstrapToken.trim() || undefined,
      });
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
          <h1 className="m-0 text-2xl font-semibold tracking-tight">初始化管理员</h1>
          <div className="muted">仅首次初始化时可用，需要 bootstrap token</div>
        </div>
        <ThemeToggle />
      </div>

      {error ? <GlobalErrorToast message={error} onDismiss={() => setError(null)} /> : null}

      <Card>
        <CardContent className="grid gap-4 p-6">
          <div className="grid gap-2">
            <Label htmlFor="bootstrapToken">Bootstrap Token</Label>
            <Input
              id="bootstrapToken"
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
              placeholder="从服务端启动日志复制"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="至少 6 位"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={submit}
                disabled={submitting || auth.status === "loading" || !bootstrapToken.trim()}
              >
                初始化管理员
              </Button>
            </div>
            <Button variant="link" size="sm" asChild>
              <Link to="/login">返回登录</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
