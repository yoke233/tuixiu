import { Navigate, Route, Routes } from "react-router-dom";

import "./App.css";
import { IssueDetailPage } from "./pages/IssueDetailPage";
import { IssueListPage } from "./pages/IssueListPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/issues" replace />} />
      <Route path="/issues" element={<IssueListPage />} />
      <Route path="/issues/:id" element={<IssueDetailPage />} />
    </Routes>
  );
}
