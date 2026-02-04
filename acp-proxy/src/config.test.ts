import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
          capabilities: {},
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
    expect(cfg.agent.capabilities).toEqual({});
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

  it("defaults sandbox.workspaceCheckout to worktree", async () => {
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
        sandbox: { provider: "boxlite_oci", image: "alpine:latest", workspaceMode: "mount" },
      }),
      "utf8",
    );
    const cfg = await loadConfig(p);
    expect(cfg.sandbox.workspaceCheckout).toBe("worktree");
  });

  it("parses sandbox.workspaceCheckout=clone", async () => {
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
          workspaceCheckout: "clone",
        },
      }),
      "utf8",
    );
    const cfg = await loadConfig(p);
    expect(cfg.sandbox.workspaceCheckout).toBe("clone");
  });

  it("parses sandbox.workspaceMode=git_clone", async () => {
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
          workspaceMode: "git_clone",
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.workspaceMode).toBe("git_clone");
  });

  it("parses sandbox.gitPush", async () => {
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
          workspaceMode: "git_clone",
          gitPush: false,
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.gitPush).toBe(false);
  });

  it("parses host_process without image", async () => {
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
          provider: "host_process",
          terminalEnabled: false,
          workspaceMode: "mount",
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.provider).toBe("host_process");
  });

  it("allows host_process with terminalEnabled", async () => {
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
          provider: "host_process",
          terminalEnabled: true,
          workspaceMode: "mount",
        },
      }),
      "utf8",
    );

    const cfg = await loadConfig(p);
    expect(cfg.sandbox.provider).toBe("host_process");
    expect(cfg.sandbox.terminalEnabled).toBe(true);
  });

  it("rejects host_process with git_clone", async () => {
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
          provider: "host_process",
          terminalEnabled: false,
          workspaceMode: "git_clone",
        },
      }),
      "utf8",
    );

    await expect(loadConfig(p)).rejects.toThrow(/host_process/);
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

  it("agent.id auto generates stable id when missing", async () => {
    const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
    await writeFile(
      p,
      JSON.stringify({
        orchestrator_url: "ws://localhost:3000/ws/agent",
        heartbeat_seconds: 30,
        mock_mode: true,
        agent_command: ["node", "--version"],
        agent: { max_concurrent: 2 },
        sandbox: {
          provider: "container_oci",
          runtime: "docker",
          image: "alpine:latest",
        },
      }),
      "utf8",
    );

    const identityDir = await mkdtemp(path.join(tmpdir(), "acp-proxy-identity-"));
    const prevIdentityPath = process.env.ACP_PROXY_IDENTITY_PATH;
    const prevAgentId = process.env.ACP_PROXY_AGENT_ID;
    process.env.ACP_PROXY_IDENTITY_PATH = path.join(identityDir, "identity.json");
    delete process.env.ACP_PROXY_AGENT_ID;

    try {
      const cfg1 = await loadConfig(p);
      expect(cfg1.agent.id).toBeTruthy();

      const cfg2 = await loadConfig(p);
      expect(cfg2.agent.id).toBe(cfg1.agent.id);
    } finally {
      if (prevIdentityPath === undefined) delete process.env.ACP_PROXY_IDENTITY_PATH;
      else process.env.ACP_PROXY_IDENTITY_PATH = prevIdentityPath;
      if (prevAgentId === undefined) delete process.env.ACP_PROXY_AGENT_ID;
      else process.env.ACP_PROXY_AGENT_ID = prevAgentId;
      await rm(identityDir, { recursive: true, force: true });
    }
  });

  it("auto-detect runtime selects docker when sandbox.runtime missing", async () => {
    const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
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
        },
      }),
      "utf8",
    );

    const binDir = await mkdtemp(path.join(tmpdir(), "acp-proxy-bin-"));
    const dockerBin = path.join(binDir, process.platform === "win32" ? "docker.cmd" : "docker");
    await writeFile(
      dockerBin,
      process.platform === "win32"
        ? "@echo off\r\necho Docker version 0.0.0\r\n"
        : "#!/bin/sh\necho Docker version 0.0.0\n",
      "utf8",
    );
    if (process.platform !== "win32") {
      await chmod(dockerBin, 0o755);
    }

    const prevPath = process.env.PATH;
    const prevRuntime = process.env.ACP_PROXY_SANDBOX_RUNTIME;
    const prevCompatRuntime = process.env.ACP_PROXY_CONTAINER_RUNTIME;
    const prevImage = process.env.ACP_PROXY_SANDBOX_IMAGE;
    delete process.env.ACP_PROXY_SANDBOX_RUNTIME;
    delete process.env.ACP_PROXY_CONTAINER_RUNTIME;
    delete process.env.ACP_PROXY_SANDBOX_IMAGE;
    process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;

    try {
      const cfg = await loadConfig(p);
      expect(cfg.sandbox.runtime).toBe("docker");
      expect(cfg.sandbox.image).toBe("tuixiu-codex-acp:local");
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevRuntime === undefined) delete process.env.ACP_PROXY_SANDBOX_RUNTIME;
      else process.env.ACP_PROXY_SANDBOX_RUNTIME = prevRuntime;
      if (prevCompatRuntime === undefined) delete process.env.ACP_PROXY_CONTAINER_RUNTIME;
      else process.env.ACP_PROXY_CONTAINER_RUNTIME = prevCompatRuntime;
      if (prevImage === undefined) delete process.env.ACP_PROXY_SANDBOX_IMAGE;
      else process.env.ACP_PROXY_SANDBOX_IMAGE = prevImage;
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
