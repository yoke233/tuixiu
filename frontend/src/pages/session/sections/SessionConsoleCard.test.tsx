import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Event } from "@/types";
import { SessionConsoleCard } from "@/pages/session/sections/SessionConsoleCard";

function configOptionsEvent(options: any[]): Event {
  return {
    id: "e1",
    runId: "r1",
    source: "acp",
    type: "acp.update.received",
    payload: {
      type: "session_update",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: options,
      },
    },
    timestamp: "2026-02-05T00:00:00.000Z",
  };
}

describe("SessionConsoleCard config menu", () => {
  it("hides option descriptions by default and exposes them via title on hover", async () => {
    const optDescription = "这是一个很长的描述（默认不直接渲染，悬浮时再显示）";
    const choiceDescription = "选项描述（悬浮显示）";

    const events: Event[] = [
      configOptionsEvent([
        {
          id: "model",
          name: "模型",
          type: "select",
          description: optDescription,
          currentValue: "gpt-5.2",
          options: [
            { name: "gpt-5.2", value: "gpt-5.2", description: choiceDescription },
            { name: "gpt-4.1", value: "gpt-4.1" },
          ],
        },
      ]),
    ];

    render(
      <SessionConsoleCard
        model={
          {
            auth: { user: { id: "u1" } },
            chatText: "",
            events,
            liveEventIds: new Set<string>(),
            issue: null,
            isAdmin: true,
            onResolvePermission: vi.fn(),
            onSetConfigOption: vi.fn(),
            onDropFiles: vi.fn(),
            onPause: vi.fn(),
            onSend: (e: any) => e.preventDefault(),
            pausing: false,
            pendingImages: [],
            permissionRequests: [],
            removePendingImage: vi.fn(),
            resolvedPermissionIds: new Set<string>(),
            resolvingPermissionId: null,
            run: null,
            runId: "r1",
            sending: false,
            sessionId: "sess_1",
            setChatText: vi.fn(),
            settingConfigOptionId: null,
            uploadingImages: false,
          } as any
        }
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "配置选项" }));
    expect(await screen.findByText("配置")).toBeInTheDocument();

    expect(screen.queryByText(optDescription)).not.toBeInTheDocument();
    expect(screen.queryByText(choiceDescription)).not.toBeInTheDocument();

    const optName = screen.getByText("模型");
    expect(optName).toHaveAttribute("title", expect.stringContaining(optDescription));

    const choice = screen.getByRole("button", { name: "gpt-5.2" });
    expect(choice).toHaveAttribute("title", expect.stringContaining(choiceDescription));
  });
});

