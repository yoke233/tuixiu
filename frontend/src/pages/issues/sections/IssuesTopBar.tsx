import { useMemo } from "react";

import { ThemeToggle } from "../../../components/ThemeToggle";
import type { IssueListController } from "../useIssueListController";

export function IssuesTopBar(props: { model: IssueListController }) {
  const { auth, loading, location, navigate, refresh, searchText, setSearchText } = props.model;

  const loginNext = useMemo(
    () => `/login?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
    [location.pathname, location.search],
  );

  return (
    <div className="issuesTopBar">
      <div className="issuesTopTitle">
        <h1>ACP 协作台</h1>
        <div className="muted">项目看板 / 需求池 / 执行面板</div>
      </div>

      <div className="row gap issuesTopActions">
        <label className="srOnly" htmlFor="issueSearch">
          搜索 Issue
        </label>
        <input
          id="issueSearch"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="搜索 Issue…"
        />
        <ThemeToggle />
        {auth.user ? (
          <div className="row gap" style={{ alignItems: "baseline" }}>
            <span className="muted" title={auth.user.id}>
              {auth.user.username} ({auth.user.role})
            </span>
            {auth.hasRole(["admin"]) ? (
              <>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => navigate("/admin?section=issues#issue-create")}
                >
                  新建 Issue
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => navigate("/admin?section=issues#issue-github-import")}
                >
                  GitHub 导入
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => navigate("/admin?section=acpSessions")}
                >
                  ACP Proxies
                </button>
                <button
                  type="button"
                  className="buttonSecondary"
                  onClick={() => navigate("/admin")}
                >
                  管理
                </button>
              </>
            ) : null}
            <button type="button" className="buttonSecondary" onClick={() => auth.logout()}>
              退出
            </button>
          </div>
        ) : (
          <button type="button" className="buttonSecondary" onClick={() => navigate(loginNext)}>
            登录
          </button>
        )}
        <button onClick={() => refresh()} disabled={loading}>
          刷新
        </button>
      </div>
    </div>
  );
}
