import { afterEach, describe, expect, it, vi } from "vitest";

const sendSpy = vi.fn();
const loadConfigSpy = vi.fn();
const createProxySandboxSpy = vi.fn();

vi.mock("./config.js", () => ({
  loadConfig: loadConfigSpy,
}));

vi.mock("./platform/createPlatform.js", () => ({
  createPlatform: vi.fn(() => ({})),
}));

vi.mock("./sandbox/createProxySandbox.js", () => ({
  createProxySandbox: createProxySandboxSpy,
}));

vi.mock("./orchestrator/orchestratorClient.js", () => {
  class OrchestratorClient {
    send(payload: unknown) {
      sendSpy(payload);
    }

    async connectLoop(opts: {
      signal?: AbortSignal;
      onMessage: (msg: any) => void | Promise<void>;
      onConnected?: () => void | Promise<void>;
      onDisconnected?: () => void | Promise<void>;
      heartbeatPayload?: () => unknown;
    }): Promise<void> {
      await opts.onConnected?.();
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await opts.onDisconnected?.();
    }
  }

  return { OrchestratorClient };
});

describe("proxy/runProxyCli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exports runProxyCli", async () => {
    const { runProxyCli } = await import("./runProxyCli.js");
    expect(typeof runProxyCli).toBe("function");
  });

  it("periodically reports sandbox_inventory after connected", async () => {
    loadConfigSpy.mockResolvedValue({
      orchestrator_url: "ws://example.invalid/ws/agent",
      auth_token: "",
      register_url: "",
      bootstrap_token: "",
      heartbeat_seconds: 1,
      inventory_interval_seconds: 1,
      mock_mode: false,
      sandbox: {
        terminalEnabled: false,
        provider: "boxlite_oci",
        image: "img",
        workingDir: "/workspace",
        volumes: [],
        env: {},
        cpus: null,
        memoryMib: null,
        workspaceMode: "mount",
        workspaceHostRoot: "C:/tmp",
        runtime: null,
      },
      agent_command: ["node", "-e", "console.log('ok')"],
      agent: { id: "a1", name: "a1", max_concurrent: 1, capabilities: {} },
    });

    createProxySandboxSpy.mockReturnValue({
      provider: "boxlite_oci",
      runtime: null,
      agentMode: "exec",
      inspectInstance: async (instanceName: string) => ({ instanceName, status: "missing", createdAt: null }),
      ensureInstanceRunning: async (opts: any) => ({ instanceName: opts.instanceName, status: "running", createdAt: null }),
      listInstances: async () => [],
      stopInstance: async () => {},
      removeInstance: async () => {},
      removeImage: async () => {},
      execProcess: async () => {
        throw new Error("not implemented");
      },
      openAgent: async () => {
        throw new Error("not implemented");
      },
    });

    const { runProxyCli } = await import("./runProxyCli.js");
    const ac = new AbortController();

    const runP = runProxyCli({ configPath: "config.toml", argv: [], signal: ac.signal });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const { createPlatform } = await import("./platform/createPlatform.js");
    expect((createPlatform as any).mock.calls[0][0]?.inventory_interval_seconds).toBe(1);

    const countInventory = () =>
      sendSpy.mock.calls
        .map((c) => c[0])
        .filter((m) => m && typeof m === "object" && (m as any).type === "sandbox_inventory").length;

    expect(loadConfigSpy).toHaveBeenCalled();

    const initial = countInventory();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(countInventory()).toBeGreaterThan(initial);

    ac.abort();
    await runP;
  });
});
