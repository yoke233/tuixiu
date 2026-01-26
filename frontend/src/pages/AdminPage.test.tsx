import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminPage } from "./AdminPage";
import { ThemeProvider } from "../theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
}

describe("AdminPage", () => {
  beforeEach(() => {
    localStorage.removeItem("showArchivedIssues");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles showArchivedIssues setting", async () => {
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    const checkbox = await screen.findByRole("checkbox", { name: "主界面显示已归档 Issue" });
    expect(checkbox).not.toBeChecked();

    await userEvent.click(checkbox);
    expect(localStorage.getItem("showArchivedIssues")).toBe("1");
  });

  it("archives issue from table", async () => {
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

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(await screen.findByText("Done issue")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "归档" }));

    expect(await screen.findByRole("button", { name: "取消归档" })).toBeInTheDocument();
  });
});

