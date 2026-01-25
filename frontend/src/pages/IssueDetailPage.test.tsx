import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssueDetailPage } from "./IssueDetailPage";

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

    // second refresh triggered by WS (3 calls)
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
    mockFetchJsonOnce({
      success: true,
      data: {
        events: [
          {
            id: "e1",
            runId: "r1",
            source: "acp",
            type: "acp.update.received",
            payload: { type: "text", text: "hi" },
            timestamp: "2026-01-25T00:00:00.000Z"
          },
          {
            id: "e2",
            runId: "r1",
            source: "acp",
            type: "acp.update.received",
            payload: { type: "text", text: "again" },
            timestamp: "2026-01-25T00:00:01.000Z"
          }
        ]
      }
    });

    render(
      <MemoryRouter initialEntries={["/issues/i1"]}>
        <Routes>
          <Route path="/issues/:id" element={<IssueDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();
    expect(await screen.findByText("branch")).toBeInTheDocument();
    expect(await screen.findByText(/acp.update.received/)).toBeInTheDocument();

    const WS = (globalThis as any).MockWebSocket;
    const instance = WS.instances[WS.instances.length - 1];
    instance.emitMessage({ type: "event_added", run_id: "r1" });

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

    render(
      <MemoryRouter initialEntries={["/issues/i1"]}>
        <Routes>
          <Route path="/issues/:id" element={<IssueDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("Fix README")).toBeInTheDocument();
    expect(await screen.findByText("r1")).toBeInTheDocument();

    // cancel
    await screen.findByRole("button", { name: "取消 Run" }).then((btn) => btn.click());

    await waitFor(() => expect(screen.getAllByText("cancelled").length).toBeGreaterThan(0));
  });
});
