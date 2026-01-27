import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("fills defaults for cwd/agent fields", async () => {
    const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { id: "codex-local-1", max_concurrent: 2, capabilities: { tools: ["git"] } },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.cwd).toBe(process.cwd());
    expect(cfg.agent.name).toBe("codex-local-1");
    expect(cfg.agent.max_concurrent).toBe(2);
    expect(cfg.agent.capabilities).toEqual({ tools: ["git"] });
    expect(cfg.sandbox.provider).toBe("host_process");
    expect(cfg.pathMapping).toBeUndefined();
  });

  it("parses sandbox.boxlite.workspaceMode", async () => {
    const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { id: "codex-local-1", max_concurrent: 2 },
        sandbox: { provider: "boxlite_oci", boxlite: { image: "alpine:latest", workspaceMode: "git_clone" } },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.provider).toBe("boxlite_oci");
    expect(cfg.sandbox.boxlite?.workspaceMode).toBe("git_clone");
  });

  it("requires sandbox.boxlite.volumes in mount mode", async () => {
    const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { id: "codex-local-1", max_concurrent: 2 },
        sandbox: { provider: "boxlite_oci", boxlite: { image: "alpine:latest", workspaceMode: "mount" } },
      }),
      "utf8",
    );

    await expect(loadConfig(p)).rejects.toThrow(/sandbox\.boxlite\.volumes|volumes/i);
  });
});
