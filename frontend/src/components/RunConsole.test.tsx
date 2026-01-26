import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Event } from "../types";
import { RunConsole } from "./RunConsole";

function textEvent(id: string, text: string, timestamp: string): Event {
  return {
    id,
    runId: "r1",
    source: "acp",
    type: "acp.update.received",
    payload: { type: "text", text },
    timestamp
  };
}

describe("RunConsole", () => {
  it("stops auto-scroll when user scrolls up, and resumes after returning to bottom", async () => {
    const events1 = [textEvent("e1", "one", "2026-01-01T00:00:00.000Z")];
    const events2 = [...events1, textEvent("e2", "two", "2026-01-01T00:00:01.000Z")];
    const events3 = [...events2, textEvent("e3", "three", "2026-01-01T00:00:02.000Z")];

    const { rerender } = render(<RunConsole events={events1} />);
    const log = screen.getByRole("log");

    const scrollTo = vi.fn();
    (log as any).scrollTo = scrollTo;

    let scrollTop = 0;
    Object.defineProperty(log, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v) => {
        scrollTop = v;
      }
    });
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 100 });

    // Start at bottom.
    scrollTop = 900;
    fireEvent.scroll(log);

    // User scrolls up: should disable stick-to-bottom.
    scrollTop = 850;
    fireEvent.scroll(log);

    scrollTo.mockClear();
    rerender(<RunConsole events={events2} />);
    await screen.findByText("two");
    await waitFor(() => expect(scrollTo).not.toHaveBeenCalled());

    // User returns to bottom: should re-enable stick-to-bottom.
    scrollTop = 900;
    fireEvent.scroll(log);

    rerender(<RunConsole events={events3} />);
    await screen.findByText("three");
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
  });
});

describe("RunConsole plan", () => {
  it("renders plan sessionUpdate as expanded details with entries", async () => {
    const events: Event[] = [
      {
        id: "e1",
        runId: "r1",
        source: "acp",
        type: "acp.update.received",
        payload: {
          type: "session_update",
          update: {
            sessionUpdate: "plan",
            entries: [
              { status: "in_progress", content: "定位 Issue 同步与数据结构", priority: "medium" },
              { status: "pending", content: "定位 PR 提交流程", priority: "medium" },
              { status: "completed", content: "补充测试与文档", priority: "low" }
            ]
          }
        },
        timestamp: "2026-01-25T00:00:00.000Z"
      }
    ];

    render(<RunConsole events={events} />);

    expect(await screen.findByText("PLAN")).toBeInTheDocument();
    expect(screen.getByText("定位 Issue 同步与数据结构")).toBeInTheDocument();
    expect(screen.getByText("定位 PR 提交流程")).toBeInTheDocument();
    expect(screen.getByText("补充测试与文档")).toBeInTheDocument();
  });
});
