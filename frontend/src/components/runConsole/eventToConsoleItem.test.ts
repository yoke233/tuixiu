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

describe("eventToConsoleItem (permission_request)", () => {
  it("maps permission_request payload into permissionRequest console item", () => {
    const item = eventToConsoleItem({
      id: "e1",
      runId: "r1",
      source: "acp",
      type: "acp.update.received",
      payload: {
        type: "permission_request",
        request_id: "1",
        session_id: "sess_1",
        prompt_id: "p1",
        tool_call: { title: "Run pnpm -v", kind: "execute" },
        options: [{ optionId: "approved", name: "Yes", kind: "allow_once" }],
      },
      timestamp: "2026-01-29T00:00:00.000Z",
    } as any);

    expect(item.role).toBe("system");
    expect(item.permissionRequest?.requestId).toBe("1");
    expect(item.permissionRequest?.sessionId).toBe("sess_1");
    expect(item.permissionRequest?.promptId).toBe("p1");
    expect(item.permissionRequest?.options?.[0]?.optionId).toBe("approved");
  });
});
