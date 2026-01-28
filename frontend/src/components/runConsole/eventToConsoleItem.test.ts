import { describe, expect, it } from "vitest";

import { eventToConsoleItem } from "./eventToConsoleItem";

describe("eventToConsoleItem (user)", () => {
  it("renders payload.prompt when present", () => {
    const item = eventToConsoleItem({
      id: "e1",
      runId: "r1",
      source: "user",
      type: "user.message",
      payload: { prompt: [{ type: "text", text: "hi" }] },
      timestamp: "2026-01-28T00:00:00.000Z",
    } as any);
    expect(item.role).toBe("user");
    expect(item.text).toContain("hi");
  });
});

