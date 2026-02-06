import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueDetailPage } from "@/pages/IssueDetailPage";
import { AuthProvider } from "@/auth/AuthProvider";
import { ThemeProvider } from "@/theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("IssueDetailPage", () => {
  beforeEach(() => {
    localStorage.setItem("authUser", JSON.stringify({ id: "u1", username: "dev", role: "dev" }));
    vi.stubGlobal("fetch", vi.fn());
    // AuthProvider 会在 mount 时调用 /auth/me；统一在 beforeEach 提供该响应，避免每个用例依赖调用顺序。
    mockFetchJsonOnce({ success: true, data: { user: { id: "u1", username: "dev", role: "dev" } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders run, events, artifacts and refreshes on WS message", async () => {
    // task templates
    mockFetchJsonOnce({ success: true, data: { templates: [] } });

    // issue detail
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          description: "desc",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [
            {
              id: "r1",
              issueId: "i1",
              agentId: "a1",
              executorType: "agent",
              status: "running",
              startedAt: "2026-01-25T00:00:00.000Z",
            },
          ],
        },
      },
    });

    // agents list
    mockFetchJsonOnce({
      success: true,
      data: { agents: [] },
    });

    // tasks list
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });

    // run
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "running",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [
            {
              id: "art1",
              runId: "r1",
              type: "branch",
              content: { branch: "acp/test" },
              createdAt: "2026-01-25T00:00:00.000Z",
            },
          ],
        },
      },
    });

    // events
    mockFetchJsonOnce({
      success: true,
      data: {
        events: [
          {
            id: "e2",
            runId: "r1",
            source: "acp",
            type: "acp.update.received",
            payload: {
              type: "session_update",
              update: {
                kind: "execute",
                title: 'Run node "..." bootstrap',
                status: "in_progress",
                rawInput: {
                  cwd: "D:\\xyad\\tuixiu",
                  call_id: "call_test_tool_1",
                  command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "echo hi"],
                },
                toolCallId: "call_test_tool_1",
                sessionUpdate: "tool_call",
              },
              session: "s1",
            },
            timestamp: "2026-01-25T00:00:00.100Z",
          },
          {
            id: "e1",
            runId: "r1",
            source: "acp",
            type: "acp.update.received",
            payload: { type: "text", text: "hi" },
            timestamp: "2026-01-25T00:00:00.000Z",
          },
        ],
      },
    });

    // roles
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues/i1"]}>
            <Routes>
              <Route path="/issues/:id" element={<IssueDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect((await screen.findAllByText("branch")).length).toBeGreaterThan(0);
    expect(await screen.findByText("hi")).toBeInTheDocument();

    const WS = (globalThis as any).MockWebSocket;
    const instance = WS.instances[WS.instances.length - 1];
    instance.emitMessage({
      type: "event_added",
      run_id: "r1",
      event: {
        id: "e9",
        runId: "r1",
        source: "acp",
        type: "acp.update.received",
        payload: { type: "text", text: "again" },
        timestamp: "2026-01-25T00:00:01.000Z",
      },
    });

    await waitFor(() => expect(screen.getByText(/again/)).toBeInTheDocument());
  });

  it("cancels run and updates status", async () => {
    // task templates
    mockFetchJsonOnce({ success: true, data: { templates: [] } });

    // issue detail
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [
            {
              id: "r1",
              issueId: "i1",
              agentId: "a1",
              executorType: "agent",
              status: "running",
              startedAt: "2026-01-25T00:00:00.000Z",
            },
          ],
        },
      },
    });

    // agents list
    mockFetchJsonOnce({
      success: true,
      data: { agents: [] },
    });

    // tasks list
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });

    // run
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "running",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [],
        },
      },
    });
    // events
    mockFetchJsonOnce({ success: true, data: { events: [] } });
    // roles
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    // cancel run (POST)
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "cancelled",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [],
        },
      },
    });

    // refresh after cancel
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "cancelled",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [
            {
              id: "r1",
              issueId: "i1",
              agentId: "a1",
              executorType: "agent",
              status: "cancelled",
              startedAt: "2026-01-25T00:00:00.000Z",
            },
          ],
        },
      },
    });
    // tasks list after cancel
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "cancelled",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [],
        },
      },
    });
    mockFetchJsonOnce({ success: true, data: { events: [] } });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues/i1"]}>
            <Routes>
              <Route path="/issues/:id" element={<IssueDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();

    // cancel
    await screen.findByRole("button", { name: "取消 Run" }).then((btn) => btn.click());

    await waitFor(() => expect(screen.getAllByText("cancelled").length).toBeGreaterThan(0));
  });

  it("keeps start run disabled before role selection when /api/agents fails", async () => {
    // task templates
    mockFetchJsonOnce({ success: true, data: { templates: [] } });

    // issue detail (no run)
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Need agent",
          status: "pending",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [],
        },
      },
    });

    // agents list fails
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, error: { code: "UPSTREAM", message: "agents down" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    // tasks list
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });
    mockFetchJsonOnce({
      success: true,
      data: { roles: [{ id: "role-1", projectId: "p1", key: "dev", displayName: "Dev" }] },
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues/i1"]}>
            <Routes>
              <Route path="/issues/:id" element={<IssueDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText("Need agent")).toBeInTheDocument();
    expect(await screen.findByText(/无法获取 Agent 列表/)).toBeInTheDocument();

    const btn = await screen.findByRole("button", { name: "启动 Run" });
    expect(btn).toBeDisabled();
    expect(screen.queryByText(/当前没有可用的在线 Agent/)).not.toBeInTheDocument();
  });

  it("loads new run events without page refresh (even when WS is open)", async () => {
    // task templates
    mockFetchJsonOnce({ success: true, data: { templates: [] } });

    // issue detail (no run yet)
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Start run live",
          status: "pending",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [],
        },
      },
    });

    // agents list (one online agent so canStartRun=true)
    mockFetchJsonOnce({
      success: true,
      data: {
        agents: [{ id: "a1", name: "agent-1", status: "online", currentLoad: 0, maxConcurrentRuns: 1 }],
      },
    });

    // tasks list
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });

    // roles
    mockFetchJsonOnce({
      success: true,
      data: { roles: [{ id: "role-1", projectId: "p1", key: "dev", displayName: "Dev" }] },
    });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues/i1"]}>
            <Routes>
              <Route path="/issues/:id" element={<IssueDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText("Start run live")).toBeInTheDocument();

    const runCardHeading = await screen.findByRole("heading", { name: "Run" });
    const runCard = runCardHeading.closest("section");
    if (!runCard) throw new Error("Run card section not found");
    await within(runCard).findByText("请选择角色").then((el) => el.click());
    await screen.findByRole("option", { name: /Dev \(dev\)/ }).then((el) => el.click());

    // start run (POST)
    mockFetchJsonOnce({
      success: true,
      data: { run: { id: "r2", issueId: "i1", status: "running", startedAt: "2026-01-25T00:00:01.000Z" } },
    });

    // refresh after start: issue detail includes new run
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Start run live",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [
            {
              id: "r2",
              issueId: "i1",
              agentId: "a1",
              executorType: "agent",
              status: "running",
              startedAt: "2026-01-25T00:00:01.000Z",
            },
          ],
        },
      },
    });

    // tasks list after start
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });

    // run
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r2",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "running",
          startedAt: "2026-01-25T00:00:01.000Z",
          artifacts: [],
        },
      },
    });

    // events for new run（WS 已连接时也应被 refresh 拉取一次，避免 run 切换瞬间丢消息导致必须手动刷新页面）
    mockFetchJsonOnce({
      success: true,
      data: {
        events: [
          {
            id: "e-new-1",
            runId: "r2",
            source: "acp",
            type: "acp.update.received",
            payload: { type: "text", text: "new-run-live" },
            timestamp: "2026-01-25T00:00:01.100Z",
          },
        ],
      },
    });

    await screen.findByRole("button", { name: "启动 Run" }).then((btn) => btn.click());

    await waitFor(() => expect(screen.getByText("new-run-live")).toBeInTheDocument());
  });

  it("pauses agent via /api/runs/:id/pause when run is running", async () => {
    // task templates
    mockFetchJsonOnce({ success: true, data: { templates: [] } });

    // issue detail
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [
            {
              id: "r1",
              issueId: "i1",
              agentId: "a1",
              executorType: "agent",
              status: "running",
              startedAt: "2026-01-25T00:00:00.000Z",
            },
          ],
        },
      },
    });

    // agents list
    mockFetchJsonOnce({ success: true, data: { agents: [] } });

    // tasks list
    mockFetchJsonOnce({ success: true, data: { tasks: [] } });

    // run + events
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          executorType: "agent",
          status: "running",
          acpSessionId: "s1",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [],
        },
      },
    });
    mockFetchJsonOnce({ success: true, data: { events: [] } });
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    render(
      <AuthProvider>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/issues/i1"]}>
            <Routes>
              <Route path="/issues/:id" element={<IssueDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();

    const pauseBtn = await screen.findByRole("button", { name: "暂停 Agent" });

    // pause (POST)
    mockFetchJsonOnce({ success: true, data: { ok: true } });
    pauseBtn.click();

    await waitFor(() =>
      expect(
        (globalThis.fetch as any).mock.calls.some((c: any[]) =>
          String(c[0]).includes("/runs/r1/pause"),
        ),
      ).toBe(true),
    );
  });
});
