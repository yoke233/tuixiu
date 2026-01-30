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
    timestamp,
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
      },
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
              { status: "completed", content: "补充测试与文档", priority: "low" },
            ],
          },
        },
        timestamp: "2026-01-25T00:00:00.000Z",
      },
    ];

    render(<RunConsole events={events} />);

    expect(await screen.findByText("PLAN")).toBeInTheDocument();
    expect(screen.getByText("定位 Issue 同步与数据结构")).toBeInTheDocument();
    expect(screen.getByText("定位 PR 提交流程")).toBeInTheDocument();
    expect(screen.getByText("补充测试与文档")).toBeInTheDocument();
  });
});

describe("RunConsole sandbox", () => {
  it("hides sandbox_instance_status payloads from console output", async () => {
    const payload = JSON.stringify({
      type: "sandbox_instance_status",
      status: "running",
      runtime: "docker",
      provider: "container_oci",
    });
    const events = [textEvent("e1", payload, "2026-01-01T00:00:00.000Z")];

    render(<RunConsole events={events} />);

    expect(await screen.findByText("暂无输出（无日志）")).toBeInTheDocument();
    expect(screen.queryByText(payload)).not.toBeInTheDocument();
  });
});

describe("RunConsole permission request", () => {
  it("renders permission_request options as buttons and emits decision", async () => {
    const events: Event[] = [
      {
        id: "e1",
        runId: "r1",
        source: "acp",
        type: "acp.update.received",
        payload: {
          type: "permission_request",
          request_id: "1",
          session_id: "sess_1",
          prompt_id: "p1",
          tool_call: {
            title: "Run pnpm -v",
            kind: "execute",
            content: [
              {
                type: "content",
                content: { type: "text", text: "需要联网下载依赖以执行 pnpm install 并完成后续构建/测试与提交。" },
              },
            ],
          },
          options: [
            { optionId: "approved-for-session", name: "Always", kind: "allow_always" },
            { optionId: "approved", name: "Yes", kind: "allow_once" },
            { optionId: "abort", name: "No, provide feedback", kind: "reject_once" },
          ],
        },
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    ];

    const onDecide = vi.fn();

    render(<RunConsole events={events} permission={{ isAdmin: true, onDecide }} />);

    expect(await screen.findByText("PERMISSION")).toBeInTheDocument();
    expect(
      screen.getByText("需要联网下载依赖以执行 pnpm install 并完成后续构建/测试与提交。"),
    ).toBeInTheDocument();

    const yes = screen.getByRole("button", { name: "Yes" });
    fireEvent.click(yes);

    expect(onDecide).toHaveBeenCalledWith({
      requestId: "1",
      sessionId: "sess_1",
      outcome: "selected",
      optionId: "approved",
    });
  });
});
