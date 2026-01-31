import { describe, expect, it, vi } from "vitest";

import { filterAgentInitEnv } from "./agentEnv.js";

describe("runs/agentEnv filterAgentInitEnv", () => {
  it("keeps only allowlisted keys (+ CODEX_HOME) and logs only keys", () => {
    const log = vi.fn();
    const ctx = {
      cfg: { agent_env_allowlist: ["FOO"] },
      log,
    } as any;

    const out = filterAgentInitEnv(ctx, "r1", {
      FOO: "1",
      BAR: "2",
      CODEX_HOME: "/x",
    });

    expect(out).toEqual({ FOO: "1", CODEX_HOME: "/x" });
    expect(log).toHaveBeenCalledWith("agent env allowlist applied", { runId: "r1", keys: ["FOO", "CODEX_HOME"] });
  });
});

