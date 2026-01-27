import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ThemeToggle } from "../components/ThemeToggle";
import { useAuth } from "../auth/AuthContext";

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
          <h1 style={{ margin: 0 }}>登录</h1>
          <div className="muted">需要登录后才能执行创建/启动/回滚等写操作</div>
        </div>
        <ThemeToggle />
      </div>

      {error ? (
        <div role="alert" className="alert">
          {error}
        </div>
      ) : null}

      <section className="card">
        <label className="label">
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin / dev / pm / reviewer" autoFocus />
        </label>
        <label className="label">
          密码
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="至少 6 位（bootstrap）" />
        </label>

        <div className="row gap" style={{ justifyContent: "space-between", marginTop: 8, flexWrap: "wrap" }}>
          <div className="row gap">
            <button type="button" onClick={() => submit("login")} disabled={submitting || auth.status === "loading" || !username.trim() || !password}>
              登录
            </button>
            <button type="button" className="buttonSecondary" onClick={() => submit("bootstrap")} disabled={submitting || auth.status === "loading"}>
              初始化管理员（首次）
            </button>
          </div>
          <Link to="/issues" className="muted">
            返回看板
          </Link>
        </div>

        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          “初始化管理员”仅在服务端尚未创建任何用户时可用。
        </div>
      </section>
    </div>
  );
}
