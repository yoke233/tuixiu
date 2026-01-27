import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueListPage } from "./IssueListPage";
import { AuthProvider } from "../auth/AuthProvider";
import { ThemeProvider } from "../theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
}

describe("IssueListPage", () => {
  beforeEach(() => {
    localStorage.removeItem("showArchivedIssues");
    localStorage.setItem("authToken", "test-token");
    localStorage.setItem("authUser", JSON.stringify({ id: "u1", username: "admin", role: "admin" }));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders issues list after loading and shows admin quick actions", async () => {
    mockFetchJsonOnce({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            name: "Demo",
            repoUrl: "https://example.com/repo.git",
            scmType: "gitlab",
            defaultBranch: "main",
            workspaceMode: "worktree",
            gitAuthMode: "https_pat",
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Fix README",
            status: "pending",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      }
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues"]}>
            <Routes>
              <Route path="/issues" element={<IssueListPage />}>
                <Route index element={<div>empty</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(screen.getByText("看板")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建 Issue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GitHub 导入" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理" })).toBeInTheDocument();
  });

  it("opens issue actions and starts run", async () => {
    mockFetchJsonOnce({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            name: "Demo",
            repoUrl: "https://example.com/repo.git",
            scmType: "gitlab",
            defaultBranch: "main",
            workspaceMode: "worktree",
            gitAuthMode: "https_pat",
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Fix README",
            status: "pending",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      }
    });

    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          status: "running"
        }
      }
    });

    mockFetchJsonOnce({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            name: "Demo",
            repoUrl: "https://example.com/repo.git",
            scmType: "gitlab",
            defaultBranch: "main",
            workspaceMode: "worktree",
            gitAuthMode: "https_pat",
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Fix README",
            status: "running",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: [{ id: "r1", status: "running" }]
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      }
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues"]}>
            <Routes>
              <Route path="/issues" element={<IssueListPage />}>
                <Route index element={<div>empty</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "操作：Fix README" }));
    expect(await screen.findByText("Issue 操作")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "启动 Run" }));

    expect((await screen.findAllByText("running")).length).toBeGreaterThan(0);
  });

  it("hides archived issues by default", async () => {
    mockFetchJsonOnce({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            name: "Demo",
            repoUrl: "https://example.com/repo.git",
            scmType: "gitlab",
            defaultBranch: "main",
            workspaceMode: "worktree",
            gitAuthMode: "https_pat",
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Visible",
            status: "done",
            archivedAt: null,
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          },
          {
            id: "i2",
            projectId: "p1",
            title: "Archived",
            status: "done",
            archivedAt: "2026-01-25T00:00:00.000Z",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 2,
        limit: 50,
        offset: 0
      }
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues"]}>
            <Routes>
              <Route path="/issues" element={<IssueListPage />}>
                <Route index element={<div>empty</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    expect(await screen.findByText("Visible")).toBeInTheDocument();
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });

  it("shows archived issues when enabled", async () => {
    localStorage.setItem("showArchivedIssues", "1");

    mockFetchJsonOnce({
      success: true,
      data: {
        projects: [
          {
            id: "p1",
            name: "Demo",
            repoUrl: "https://example.com/repo.git",
            scmType: "gitlab",
            defaultBranch: "main",
            workspaceMode: "worktree",
            gitAuthMode: "https_pat",
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Visible",
            status: "done",
            archivedAt: null,
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          },
          {
            id: "i2",
            projectId: "p1",
            title: "Archived",
            status: "done",
            archivedAt: "2026-01-25T00:00:00.000Z",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 2,
        limit: 50,
        offset: 0
      }
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues"]}>
            <Routes>
              <Route path="/issues" element={<IssueListPage />}>
                <Route index element={<div>empty</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    expect(await screen.findByText("Archived")).toBeInTheDocument();
  });
});
