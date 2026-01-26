import { describe, expect, it } from "vitest";

import * as acp from "@agentclientprotocol/sdk";

import { AcpBridge } from "./acpBridge";
import type { AcpTransport, AgentLauncher } from "./launchers/types";

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
      cwd: "/tmp",
      log: () => {},
      onSessionUpdate: () => {},
    });

    await Promise.all([bridge.ensureInitialized(), bridge.ensureInitialized()]);

    expect(launchCount).toBe(1);
    expect(initializeCount).toBe(1);
  });
});

