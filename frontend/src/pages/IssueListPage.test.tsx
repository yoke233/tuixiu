import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueListPage } from "./IssueListPage";
import { ThemeProvider } from "../theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
}

describe("IssueListPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders issues list after loading", async () => {
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
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues"]}>
          <Routes>
            <Route path="/issues" element={<IssueListPage />}>
              <Route index element={<div>empty</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(screen.getByText("看板")).toBeInTheDocument();
  });

  it("shows error when creating issue without project", async () => {
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues"]}>
          <Routes>
            <Route path="/issues" element={<IssueListPage />}>
              <Route index element={<div>empty</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByText("请先创建 Project")).toBeInTheDocument());

    await userEvent.click(screen.getByText("创建 / 配置"));
    await userEvent.type(screen.getByLabelText("Issue 标题"), "Test issue");
    await userEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("请先创建 Project");
  });

  it("creates project then shows it in selector", async () => {
    // initial refresh: projects=[], issues=[]
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    // create project
    mockFetchJsonOnce({
      success: true,
      data: {
        project: {
          id: "p1",
          name: "Demo",
          repoUrl: "https://example.com/repo.git",
          scmType: "gitlab",
          defaultBranch: "main",
          createdAt: "2026-01-25T00:00:00.000Z"
        }
      }
    });
    // refresh after creation: projects=[p1], issues=[]
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
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    // load roles after project selected
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues"]}>
          <Routes>
            <Route path="/issues" element={<IssueListPage />}>
              <Route index element={<div>empty</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    await userEvent.click(screen.getByText("创建 / 配置"));

    await userEvent.type(screen.getByLabelText("名称"), "Demo");
    await userEvent.type(screen.getByLabelText("Repo URL"), "https://example.com/repo.git");
    const projectsCard = screen.getByRole("heading", { name: "Projects" }).closest("section");
    if (!projectsCard) throw new Error("Projects section not found");
    await userEvent.click(within(projectsCard).getByRole("button", { name: "创建" }));

    expect(await screen.findByLabelText("选择 Project")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Demo" })).toBeInTheDocument();
  });

  it("creates issue then shows it in list", async () => {
    // initial refresh: projects=[p1], issues=[]
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
            createdAt: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });
    // load roles when opening tools
    mockFetchJsonOnce({ success: true, data: { roles: [] } });
    // create issue
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "pending",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: []
        },
      }
    });
    // refresh after creation
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
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues"]}>
          <Routes>
            <Route path="/issues" element={<IssueListPage />}>
              <Route index element={<div>empty</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    await waitFor(() => expect(screen.getByLabelText("选择 Project")).toBeInTheDocument());
    await userEvent.click(screen.getByText("创建 / 配置"));
    await userEvent.type(screen.getByLabelText("Issue 标题"), "Fix README");
    await userEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
  });
});
