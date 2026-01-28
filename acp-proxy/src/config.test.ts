import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("fills defaults for cwd/agent fields", async () => {
    const p = path.join(
      tmpdir(),
      `acp-proxy-config-${Date.now()}-${Math.random()}.json`,
    );
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: {
          id: "codex-local-1",
          max_concurrent: 2,
          capabilities: { tools: ["git"] },
        },
        sandbox: {
          provider: "container_oci",
          runtime: "docker",
          image: "alpine:latest",
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.agent.name).toBe("codex-local-1");
    expect(cfg.agent.max_concurrent).toBe(2);
    expect(cfg.agent.capabilities).toEqual({ tools: ["git"] });
    expect(cfg.sandbox.terminalEnabled).toBe(false);
  });

  it("parses sandbox.workspaceMode", async () => {
    const p = path.join(
      tmpdir(),
      `acp-proxy-config-${Date.now()}-${Math.random()}.json`,
    );
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { id: "codex-local-1", max_concurrent: 2 },
        sandbox: {
          provider: "boxlite_oci",
          image: "alpine:latest",
          workspaceMode: "mount",
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.workspaceMode).toBe("mount");
  });

  it("applies profile overrides", async () => {
    const p = path.join(
      tmpdir(),
      `acp-proxy-config-${Date.now()}-${Math.random()}.json`,
    );
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { id: "codex-local-1", max_concurrent: 2 },
        sandbox: {
          provider: "container_oci",
          runtime: "docker",
          image: "alpine:latest",
        },
        profiles: {
          sandboxed: {
            orchestrator_url: "ws://example.com/ws/agent",
            sandbox: { terminalEnabled: true },
          },
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p, { profile: "sandboxed" });
    expect(cfg.orchestrator_url).toBe("ws://example.com/ws/agent");
    expect(cfg.sandbox.terminalEnabled).toBe(true);
  });
});
