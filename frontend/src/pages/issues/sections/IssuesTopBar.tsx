import { useMemo } from "react";

import { ThemeToggle } from "../../../components/ThemeToggle";
import type { IssueListController } from "../useIssueListController";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
        <Input
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
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate("/admin?section=issues#issue-create")}
                >
                  新建 Issue
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate("/admin?section=issues#issue-github-import")}
                >
                  GitHub 导入
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate("/admin?section=acpSessions")}
                >
                  ACP Proxies
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate("/admin")}
                >
                  管理
                </Button>
              </>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={() => auth.logout()}>
              退出
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => navigate(loginNext)}>
            登录
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => refresh()} disabled={loading}>
          刷新
        </Button>
      </div>
    </div>
  );
}
