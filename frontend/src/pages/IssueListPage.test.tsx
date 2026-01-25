import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueListPage } from "./IssueListPage";

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
      <MemoryRouter>
        <IssueListPage />
      </MemoryRouter>
    );

    expect(await screen.findByRole("link", { name: "Fix README" })).toBeInTheDocument();
    expect(screen.getByText("Issues")).toBeInTheDocument();
  });

  it("shows error when creating issue without project", async () => {
    mockFetchJsonOnce({ success: true, data: { projects: [] } });
    mockFetchJsonOnce({ success: true, data: { issues: [], total: 0, limit: 50, offset: 0 } });

    render(
      <MemoryRouter>
        <IssueListPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("暂无 Project，请先创建")).toBeInTheDocument());

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

    render(
      <MemoryRouter>
        <IssueListPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText("暂无 Project，请先创建")).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("名称"), "Demo");
    await userEvent.type(screen.getByLabelText("Repo URL"), "https://example.com/repo.git");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));

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
    // create issue
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: []
        },
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          status: "running",
          startedAt: "2026-01-25T00:00:00.000Z"
        }
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
            status: "running",
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
      <MemoryRouter>
        <IssueListPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByLabelText("选择 Project")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Issue 标题"), "Fix README");
    await userEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(await screen.findByRole("link", { name: "Fix README" })).toBeInTheDocument();
  });
});
