import { describe, expect, it } from "vitest";

import { resolveAgentWorkspaceCwd } from "../../src/utils/agentWorkspaceCwd.js";

describe("agentWorkspaceCwd", () => {
  it("workspaceProvider guest uses per-run workspace path", () => {
    expect(
      resolveAgentWorkspaceCwd({ runId: "r1", sandboxWorkspaceProvider: "guest" }),
    ).toBe("/workspace/run-r1");
  });

  it("workspaceProvider host uses /workspace", () => {
    expect(
      resolveAgentWorkspaceCwd({ runId: "r1", sandboxWorkspaceProvider: "host" }),
    ).toBe("/workspace");
  });
});
