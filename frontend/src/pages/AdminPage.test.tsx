import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPage } from "@/pages/AdminPage";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider } from "@/theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
}

describe("AdminPage", () => {
  beforeEach(() => {
    localStorage.removeItem("showArchivedIssues");
    localStorage.removeItem("selectedProjectId");
    localStorage.setItem("authUser", JSON.stringify({ id: "u1", username: "admin", role: "admin" }));
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles showArchivedIssues setting", async () => {
    mockFetchJsonOnce({ success: true, data: { user: { id: "u1", username: "admin", role: "admin" } } });
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin"]}>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "Issue 归档" }));

    const checkbox = await screen.findByRole("checkbox", { name: "主界面显示已归档 Issue" });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);
    expect(localStorage.getItem("showArchivedIssues")).toBe("1");
  });

  it("archives issue from table", async () => {
    mockFetchJsonOnce({ success: true, data: { user: { id: "u1", username: "admin", role: "admin" } } });
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
            title: "Done issue",
            status: "done",
            archivedAt: null,
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      }
    });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    // archive list fetch (paged)
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Done issue",
            status: "done",
            archivedAt: null,
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      }
    });

    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Done issue",
          status: "done",
          archivedAt: "2026-01-25T00:00:00.000Z",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: []
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
            title: "Done issue",
            status: "done",
            archivedAt: "2026-01-25T00:00:00.000Z",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 50,
        offset: 0
      }
    });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    // archive list refetch after toggle
    mockFetchJsonOnce({
      success: true,
      data: {
        issues: [
          {
            id: "i1",
            projectId: "p1",
            title: "Done issue",
            status: "done",
            archivedAt: "2026-01-25T00:00:00.000Z",
            createdAt: "2026-01-25T00:00:00.000Z",
            runs: []
          }
        ],
        total: 1,
        limit: 20,
        offset: 0
      }
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin"]}>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "Issue 归档" }));

    expect(await screen.findByText("Done issue")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "归档" }));

    expect(await screen.findByRole("button", { name: "取消归档" })).toBeInTheDocument();
  });

  it("syncs active section with url query", async () => {
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin?section=archive"]}>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    expect(await screen.findByRole("heading", { name: "Issue 归档", level: 1 })).toBeInTheDocument();
  });

  it("Prune Orphans triggers sandbox control request", async () => {
    mockFetchJsonOnce({ success: true, data: { user: { id: "u1", username: "admin", role: "admin" } } });
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    mockFetchJsonOnce({
      success: true,
      data: {
        agents: [
          {
            id: "a1",
            proxyId: "proxy-1",
            name: "agent-1",
            status: "online",
            currentLoad: 0,
            maxConcurrentRuns: 1,
            createdAt: "2026-01-25T00:00:00.000Z",
          },
        ],
      },
    });
    mockFetchJsonOnce({ success: true, data: { total: 0, limit: 500, offset: 0, sandboxes: [] } });
    mockFetchJsonOnce({ success: true, data: { sessions: [] } });

    mockFetchJsonOnce({ success: true, data: { ok: true, requestId: "r-1" } });

    vi.stubGlobal("alert", vi.fn());

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin"]}>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "ACP Proxies" }));

    const btn = await screen.findByRole("button", { name: "Prune Orphans" });
    await userEvent.click(btn);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/sandboxes/control"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "prune_orphans", proxyId: "proxy-1" }),
      })
    );
  });

  it("Remove Workspace triggers sandbox control request", async () => {
    mockFetchJsonOnce({ success: true, data: { user: { id: "u1", username: "admin", role: "admin" } } });
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    mockFetchJsonOnce({ success: true, data: { approvals: [] } });

    mockFetchJsonOnce({
      success: true,
      data: {
        agents: [
          {
            id: "a1",
            proxyId: "proxy-1",
            name: "agent-1",
            status: "online",
            currentLoad: 0,
            maxConcurrentRuns: 1,
            createdAt: "2026-01-25T00:00:00.000Z",
          },
        ],
      },
    });
    mockFetchJsonOnce({ success: true, data: { total: 0, limit: 500, offset: 0, sandboxes: [] } });
    mockFetchJsonOnce({ success: true, data: { sessions: [] } });

    mockFetchJsonOnce({ success: true, data: { ok: true, requestId: "r-2" } });

    vi.stubGlobal("prompt", vi.fn().mockReturnValue("00000000-0000-0000-0000-000000000001"));
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    vi.stubGlobal("alert", vi.fn());

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin"]}>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>
    );

    await userEvent.click(await screen.findByRole("button", { name: "ACP Proxies" }));

    const btn = await screen.findByRole("button", { name: "Remove Workspace" });
    await userEvent.click(btn);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/sandboxes/control"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "remove_workspace", runId: "00000000-0000-0000-0000-000000000001" }),
      })
    );
  });
});
