import type { ReactElement } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";

import "./App.css";
import { AuthProvider } from "./auth/AuthProvider";
import { useAuth } from "./auth/AuthContext";
import { ThemeProvider } from "./theme";
import { AdminPage } from "./pages/AdminPage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssueListPage } from "./pages/IssueListPage";
import { LoginPage } from "./pages/LoginPage";
import { SessionPage } from "./pages/SessionPage";

function RequireAdmin(props: { children: ReactElement }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "loading" && !auth.user) return <div className="detailEmpty">加载中…</div>;
  if (!auth.user) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (!auth.hasRole(["admin"])) {
    return <Navigate to="/issues" replace />;
  }
  return props.children;
}

function RequireAuth(props: { children: ReactElement }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === "loading" && !auth.user) return <div className="detailEmpty">加载中…</div>;
  if (!auth.user) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return props.children;
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/issues" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/issues"
            element={
              <RequireAuth>
                <IssueListPage />
              </RequireAuth>
            }
          >
            <Route index element={<div className="detailEmpty">选择一个 Issue 查看详情</div>} />
            <Route path=":id" element={<IssueDetailPage />} />
          </Route>
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/sessions/:runId"
            element={
              <RequireAuth>
                <SessionPage />
              </RequireAuth>
            }
          />
        </Routes>
      </ThemeProvider>
    </AuthProvider>
  );
}
