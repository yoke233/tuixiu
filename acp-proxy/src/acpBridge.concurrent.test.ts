import { describe, expect, it } from "vitest";

import * as acp from "@agentclientprotocol/sdk";

import { AcpBridge } from "./acpBridge.js";
import type { AcpTransport, AgentLauncher } from "./launchers/types.js";
import type { SandboxProvider } from "./sandbox/types.js";

describe("AcpBridge concurrency", () => {
  it("dedupes concurrent ensureInitialized() calls", async () => {
    let launchCount = 0;
    let initializeCount = 0;

    const launcher: AgentLauncher = {
      async launch(): Promise<AcpTransport> {
        launchCount += 1;

        const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

        const agentImpl: acp.Agent = {
          async initialize(_params) {
            initializeCount += 1;
            return {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [],
            };
          },
          async newSession() {
            return { sessionId: "s1" };
          },
          async loadSession() {
            return {};
          },
          async authenticate() {},
          async prompt() {
            return { stopReason: "end_turn" };
          },
          async cancel() {},
        };

        new acp.AgentSideConnection(
          () => agentImpl,
          acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
        );

        // Slow down launch so two concurrent calls race.
        await new Promise((r) => setTimeout(r, 30));

        return {
          input: clientToAgent.writable,
          output: agentToClient.readable,
          close: async () => {},
        };
      },
    };

    const bridge = new AcpBridge({
      launcher,
      sandbox: { runProcess: async () => { throw new Error("not used"); } } satisfies SandboxProvider,
      cwd: "/tmp",
      log: () => {},
      onSessionUpdate: () => {},
    });

    await Promise.all([bridge.ensureInitialized(), bridge.ensureInitialized()]);

    expect(launchCount).toBe(1);
    expect(initializeCount).toBe(1);
  });
  it("sends session/cancel to agent", async () => {
    let cancelCount = 0;
    let cancelledSessionId = "";

    const launcher: AgentLauncher = {
      async launch(): Promise<AcpTransport> {
        const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

        const agentImpl: acp.Agent = {
          async initialize(_params) {
            return {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [],
            };
          },
          async newSession() {
            return { sessionId: "s1" };
          },
          async loadSession() {
            return {};
          },
          async authenticate() {},
          async prompt() {
            return { stopReason: "end_turn" };
          },
          async cancel(params) {
            cancelCount += 1;
            cancelledSessionId = params.sessionId;
          },
        };

        new acp.AgentSideConnection(
          () => agentImpl,
          acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
        );

        return {
          input: clientToAgent.writable,
          output: agentToClient.readable,
          close: async () => {},
        };
      },
    };

    const bridge = new AcpBridge({
      launcher,
      sandbox: { runProcess: async () => { throw new Error("not used"); } } satisfies SandboxProvider,
      cwd: "/tmp",
      log: () => {},
      onSessionUpdate: () => {},
    });

    await bridge.ensureInitialized();
    await (bridge as any).cancel("s1");

    expect(cancelCount).toBe(1);
    expect(cancelledSessionId).toBe("s1");
  });
});
