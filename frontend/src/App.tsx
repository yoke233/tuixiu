import { Navigate, Route, Routes } from "react-router-dom";

import "./App.css";
import { ThemeProvider } from "./theme";
import { AdminPage } from "./pages/AdminPage";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssueListPage } from "./pages/IssueListPage";

export default function App() {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/issues" replace />} />
        <Route path="/issues" element={<IssueListPage />}>
          <Route index element={<div className="detailEmpty">选择一个 Issue 查看详情</div>} />
          <Route path=":id" element={<IssueDetailPage />} />
        </Route>
        <Route path="/admin" element={<AdminPage />} />
      </Routes>
    </ThemeProvider>
  );
}
