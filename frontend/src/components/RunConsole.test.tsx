import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Event } from "../types";
import { RunConsole } from "./RunConsole";

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

