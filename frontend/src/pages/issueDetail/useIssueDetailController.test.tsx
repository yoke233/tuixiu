import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";

import { useIssueDetailController } from "@/pages/issueDetail/useIssueDetailController";

const { listRunEvents } = vi.hoisted(() => ({ listRunEvents: vi.fn() }));

vi.mock("@/api/agents", () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/issues", () => ({
  getIssue: vi.fn().mockResolvedValue({
    id: "i1",
    projectId: "p1",
    status: "running",
    title: "Issue",
    description: "",
    createdAt: new Date("2026-02-05T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-02-05T00:00:00.000Z").toISOString(),
    externalProvider: "github",
    externalNumber: 1,
    labels: [],
    archivedAt: null,
    runs: [{ id: "r1" }],
  }),
  startIssue: vi.fn(),
  updateIssue: vi.fn(),
  listIssues: vi.fn(),
}));
vi.mock("@/api/pm", () => ({
  analyzeIssue: vi.fn(),
  dispatchIssue: vi.fn(),
  getIssueNextAction: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/api/roles", () => ({
  listRoles: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/api/runs", () => ({
  cancelRun: vi.fn(),
  completeRun: vi.fn(),
  getRun: vi.fn().mockResolvedValue({
    id: "r1",
    issueId: "i1",
    status: "running",
    createdAt: new Date("2026-02-05T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-02-05T00:00:00.000Z").toISOString(),
    branchName: "run-branch",
    artifacts: [],
    agentId: null,
    acpSessionId: null,
    completedAt: null,
  }),
  listRunEvents,
  pauseRun: vi.fn(),
  promptRun: vi.fn(),
  submitRun: vi.fn(),
  uploadRunAttachment: vi.fn(),
}));
vi.mock("@/api/steps", () => ({
  startStep: vi.fn(),
  rollbackTask: vi.fn(),
}));
vi.mock("@/api/tasks", () => ({
  createIssueTask: vi.fn(),
  listIssueTasks: vi.fn().mockResolvedValue([]),
  listTaskTemplates: vi.fn().mockResolvedValue([]),
}));

function Probe(props: { issueId: string; onModel: (model: any) => void }) {
  const model = useIssueDetailController({ issueId: props.issueId, outlet: null });
  useEffect(() => {
    props.onModel(model);
  }, [model, props]);
  return (
    <div>
      <div data-testid="ws">{model.ws.status}</div>
      <div data-testid="events">{model.events.map((e: any) => e.id).join(",")}</div>
    </div>
  );
}

describe("useIssueDetailController", () => {
  it("refresh does not clear events when ws is open and snapshot already loaded", async () => {
    listRunEvents.mockResolvedValue([
      {
        id: "e1",
        timestamp: new Date("2026-02-05T00:00:01.000Z").toISOString(),
        payload: { type: "text", text: "hello" },
      },
      {
        id: "e2",
        timestamp: new Date("2026-02-05T00:00:02.000Z").toISOString(),
        payload: { type: "text", text: "world" },
      },
    ]);

    let model: any = null;
    render(
      <MemoryRouter initialEntries={["/issues/i1"]}>
        <Probe issueId="i1" onModel={(m) => (model = m)} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("events").textContent).toContain("e1"));
    await waitFor(() => expect(screen.getByTestId("ws").textContent).toBe("open"));
    expect(listRunEvents).toHaveBeenCalledTimes(1);

    await act(async () => {
      await model.refresh({ silent: true });
    });

    expect(screen.getByTestId("events").textContent).toContain("e1");
    expect(screen.getByTestId("events").textContent).toContain("e2");
    expect(listRunEvents).toHaveBeenCalledTimes(1);
  });
});
