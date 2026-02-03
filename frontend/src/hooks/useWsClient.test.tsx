import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useWsClient } from "./useWsClient";

function TestComponent(props: { onMessage: (msg: any) => void }) {
  const ws = useWsClient(props.onMessage);
  return <div>status:{ws.status}</div>;
}

describe("useWsClient", () => {
  it("connects, parses messages, and closes on unmount", async () => {
    const onMessage = vi.fn();
    const { unmount } = render(<TestComponent onMessage={onMessage} />);

    await waitFor(() => expect(screen.getByText(/status:open/)).toBeInTheDocument());

    const WS = (globalThis as any).MockWebSocket;
    const instance = WS.instances[WS.instances.length - 1];
    instance.emitMessage({ type: "event_added", run_id: "r1" });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "event_added", run_id: "r1" }));

    instance.emitMessage("{not_json");
    expect(onMessage).toHaveBeenCalledTimes(1);

    unmount();
    expect(instance.readyState).toBe(3);
  });

  it("does not append token to ws url", async () => {
    const onMessage = vi.fn();
    render(<TestComponent onMessage={onMessage} />);

    await waitFor(() => expect(screen.getByText(/status:open/)).toBeInTheDocument());

    const WS = (globalThis as any).MockWebSocket;
    const instance = WS.instances[WS.instances.length - 1];
    expect(String(instance.url)).not.toMatch(/token=/);
  });
});
