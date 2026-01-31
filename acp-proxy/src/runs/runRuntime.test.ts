import { describe, expect, it, vi } from "vitest";

import { NativePlatform } from "../platform/native/nativePlatform.js";
import { ensureSessionForPrompt } from "./runRuntime.js";

describe("runs/runRuntime", () => {
  it("mode=auto: session/new applies config option when offered", async () => {
    const sendRpc = vi.fn(async (method: string, params: any) => {
      if (method === "session/new") {
        return {
          sessionId: "s1",
          configOptions: [
            {
              id: "mode",
              currentValue: "ask",
              options: [{ value: "ask" }, { value: "auto" }],
            },
          ],
        };
      }
      if (method === "session/set_config_option") {
        return { ok: true };
      }
      throw new Error(`unexpected rpc: ${method} ${JSON.stringify(params)}`);
    });

    const ctx = {
      cfg: { sandbox: { terminalEnabled: false } },
      sandbox: { provider: "boxlite_oci", runtime: null, agentMode: "exec" },
      platform: new NativePlatform("win32"),
      log: vi.fn(),
    } as any;

    const run = {
      runId: "r1",
      instanceName: "i1",
      keepaliveTtlSeconds: 0,
      expiresAt: null,
      lastUsedAt: Date.now(),
      opQueue: Promise.resolve(),
      hostWorkspacePath: "D:\\workspaces\\run-1",
      agent: { sendRpc } as any,
      suppressNextAcpExit: false,
      acpClient: null,
      initialized: true,
      initResult: { agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] },
      seenSessionIds: new Set<string>(),
      activePromptId: null,
    } as any;

    await ensureSessionForPrompt(ctx, run, { cwd: "/workspace", prompt: [{ type: "text", text: "hi" }] });

    expect(sendRpc).toHaveBeenCalledWith(
      "session/set_config_option",
      expect.objectContaining({ sessionId: "s1", configId: "mode", value: "auto" }),
    );
  });
});

