import { describe, expect, it } from "vitest";

import { buildChatContextFromEvents, buildContextFromRun } from "../../../src/modules/runs/runContext.js";

describe("runContext", () => {
  it("builds context with issue fields and conversation excerpts", () => {
    const context = buildContextFromRun({
      run: { branchName: "feat-1" },
      issue: {
        title: "Issue title",
        description: "Issue desc",
        acceptanceCriteria: ["a1", "a2"],
        constraints: ["c1"],
        testRequirements: "pnpm test",
      },
      events: [
        { source: "user", payload: { text: "hello" }, timestamp: "1" },
        {
          source: "acp",
          payload: {
            type: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } },
          },
          timestamp: "2",
        },
        {
          source: "acp",
          payload: {
            type: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } },
          },
          timestamp: "3",
        },
        { source: "acp", payload: { type: "text", text: "system note" }, timestamp: "4" },
      ],
    });

    expect(context).toContain("任务标题: Issue title");
    expect(context).toContain("任务描述:");
    expect(context).toContain("验收标准:");
    expect(context).toContain("约束条件:");
    expect(context).toContain("测试要求:");
    expect(context).toContain("当前分支: feat-1");
    expect(context).toContain("User: hello");
    expect(context).toContain("Agent: hi there");
    expect(context).toContain("System: system note");
  });

  it("summarizes ACP content blocks when user text missing", () => {
    const context = buildContextFromRun({
      run: {},
      issue: {},
      events: [
        {
          source: "user",
          payload: { prompt: [{ type: "text", text: "block text" }] },
          timestamp: "1",
        },
      ],
    });
    expect(context).toContain("User: block text");
  });

  it("builds chat-only context from events", () => {
    const context = buildChatContextFromEvents([
      { source: "user", payload: { text: "hello" }, timestamp: "1" },
      {
        source: "acp",
        payload: {
          type: "session_update",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
        timestamp: "2",
      },
    ]);
    expect(context).toContain("User: hello");
    expect(context).toContain("Agent: hi");
  });
});
