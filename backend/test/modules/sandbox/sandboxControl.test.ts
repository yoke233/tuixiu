import { describe, expect, it, vi } from "vitest";

import { createSandboxControlClient } from "../../../src/modules/sandbox/sandboxControl.js";

describe("sandboxControl", () => {
  it("resolves on ok result and sends payload", async () => {
    const sendToAgent = vi.fn();
    const client = createSandboxControlClient({ sendToAgent });

    const promise = client.gitPush({
      proxyId: "p1",
      runId: "r1",
      instanceName: "inst",
      branch: "b1",
      cwd: "/work",
      env: { A: "1" },
      timeoutSeconds: 10,
      remote: "origin",
    });

    expect(sendToAgent).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        type: "sandbox_control",
        action: "git_push",
        run_id: "r1",
        instance_name: "inst",
        branch: "b1",
        cwd: "/work",
        env: { A: "1" },
        timeout_seconds: 10,
        remote: "origin",
      }),
    );

    const payload = sendToAgent.mock.calls[0][1];
    client.handlers.handleSandboxControlResult("p1", {
      request_id: payload.request_id,
      ok: true,
      action: "git_push",
      stdout: "ok",
    });

    await expect(promise).resolves.toEqual(
      expect.objectContaining({ ok: true, action: "git_push", stdout: "ok" }),
    );
  });

  it("rejects on error result", async () => {
    const sendToAgent = vi.fn();
    const client = createSandboxControlClient({ sendToAgent });

    const promise = client.gitPush({
      proxyId: "p1",
      runId: "r1",
      instanceName: "inst",
      branch: "b1",
      cwd: "/work",
    });
    const payload = sendToAgent.mock.calls[0][1];
    client.handlers.handleSandboxControlResult("p1", {
      request_id: payload.request_id,
      ok: false,
      error: "boom",
    });

    await expect(promise).rejects.toThrow("boom");
  });

  it("ignores unknown results and disconnect rejects pending", async () => {
    const sendToAgent = vi.fn();
    const client = createSandboxControlClient({ sendToAgent });

    const promise = client.gitPush({
      proxyId: "p1",
      runId: "r1",
      instanceName: "inst",
      branch: "b1",
      cwd: "/work",
    });

    client.handlers.handleSandboxControlResult("p1", { request_id: "unknown", ok: true });
    client.handlers.handleProxyDisconnected("p1");

    await expect(promise).rejects.toThrow("proxy disconnected");
  });

  it("times out when no response", async () => {
    vi.useFakeTimers();
    const sendToAgent = vi.fn();
    const client = createSandboxControlClient({ sendToAgent });

    const promise = client.gitPush({
      proxyId: "p1",
      runId: "r1",
      instanceName: "inst",
      branch: "b1",
      cwd: "/work",
      timeoutSeconds: 5,
    });

    const outcome = promise.then(
      () => null,
      (err) => err as Error,
    );
    await vi.advanceTimersByTimeAsync(5000);
    const err = await outcome;
    expect(err?.message).toContain("sandbox_control timeout");
    vi.useRealTimers();
  });
});
