import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueDetailPage } from "./IssueDetailPage";
import { ThemeProvider } from "../theme";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  );
}

describe("IssueDetailPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders run, events, artifacts and refreshes on WS message", async () => {
    // initial refresh (3 calls)
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
          runs: [{ id: "r1", issueId: "i1", agentId: "a1", status: "running", startedAt: "2026-01-25T00:00:00.000Z" }]
        }
      }
    });

    // agents list (1 call)
    mockFetchJsonOnce({
      success: true,
      data: { agents: [] }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          status: "running",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: [
            {
              id: "art1",
              runId: "r1",
              type: "branch",
              content: { branch: "acp/test" },
              createdAt: "2026-01-25T00:00:00.000Z"
            }
          ]
        }
      }
    });
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
                title: "Run node \"...\" bootstrap",
                status: "in_progress",
                rawInput: {
                  cwd: "D:\\xyad\\tuixiu",
                  call_id: "call_test_tool_1",
                  command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "echo hi"]
                },
                toolCallId: "call_test_tool_1",
                sessionUpdate: "tool_call"
              },
              session: "s1"
            },
            timestamp: "2026-01-25T00:00:00.100Z"
          },
          {
            id: "e1",
            runId: "r1",
            source: "acp",
            type: "acp.update.received",
            payload: { type: "text", text: "hi" },
            timestamp: "2026-01-25T00:00:00.000Z"
          }
        ]
      }
    });
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues/i1"]}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(await screen.findByText("branch")).toBeInTheDocument();
    expect(await screen.findByText("hi")).toBeInTheDocument();
    expect(await screen.findByText(/工具调用/)).toBeInTheDocument();

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
        timestamp: "2026-01-25T00:00:01.000Z"
      }
    });

    await waitFor(() => expect(screen.getByText(/again/)).toBeInTheDocument());
  });

  it("cancels run and updates status", async () => {
    // initial refresh (3 calls)
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "running",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [{ id: "r1", issueId: "i1", agentId: "a1", status: "running", startedAt: "2026-01-25T00:00:00.000Z" }]
        }
      }
    });

    // agents list (1 call)
    mockFetchJsonOnce({
      success: true,
      data: { agents: [] }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          status: "running",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: []
        }
      }
    });
    mockFetchJsonOnce({ success: true, data: { events: [] } });
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    // cancel run (POST)
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          status: "cancelled",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: []
        }
      }
    });

    // refresh after cancel (3 calls)
    mockFetchJsonOnce({
      success: true,
      data: {
        issue: {
          id: "i1",
          projectId: "p1",
          title: "Fix README",
          status: "cancelled",
          createdAt: "2026-01-25T00:00:00.000Z",
          runs: [{ id: "r1", issueId: "i1", agentId: "a1", status: "cancelled", startedAt: "2026-01-25T00:00:00.000Z" }]
        }
      }
    });
    mockFetchJsonOnce({
      success: true,
      data: {
        run: {
          id: "r1",
          issueId: "i1",
          agentId: "a1",
          status: "cancelled",
          startedAt: "2026-01-25T00:00:00.000Z",
          artifacts: []
        }
      }
    });
    mockFetchJsonOnce({ success: true, data: { events: [] } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues/i1"]}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();

    // cancel
    await screen.findByRole("button", { name: "取消 Run" }).then((btn) => btn.click());

    await waitFor(() => expect(screen.getAllByText("cancelled").length).toBeGreaterThan(0));
  });

  it("keeps start run enabled when /api/agents fails", async () => {
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
          runs: []
        }
      }
    });

    // agents list fails
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: { code: "UPSTREAM", message: "agents down" } }), {
        status: 500,
        headers: { "content-type": "application/json" }
      })
    );
    mockFetchJsonOnce({ success: true, data: { roles: [] } });

    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={["/issues/i1"]}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(await screen.findByText("Need agent")).toBeInTheDocument();
    expect(await screen.findByText(/无法获取 Agent 列表/)).toBeInTheDocument();

    const btn = await screen.findByRole("button", { name: "启动 Run" });
    expect(btn).not.toBeDisabled();
    expect(screen.queryByText(/当前没有可用的在线 Agent/)).not.toBeInTheDocument();
  });
});
