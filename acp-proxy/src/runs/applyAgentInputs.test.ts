import { describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import { applyAgentInputs } from "./applyAgentInputs.js";
import { parseAgentInputsFromInit } from "./agentInputs.js";

describe("runs/agentInputs + applyAgentInputs", () => {
  it("writeFile + USER_HOME writes file and creates parent dirs", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-agentInputs-"));
    const home = path.join(rootDir, "home-r1");
    await fs.mkdir(home, { recursive: true });

    try {
      const ctx = {
        cfg: { orchestrator_url: "http://localhost", skills_download_max_bytes: 1_000_000 },
        log: vi.fn(),
      } as any;
      const run = { runId: "r1", hostWorkspacePath: path.join(rootDir, "ws-r1"), hostUserHomePath: home } as any;

      await applyAgentInputs({
        ctx,
        run,
        manifest: {
          version: 1,
          items: [
            {
              id: "agents-md",
              apply: "writeFile",
              access: "rw",
              source: { type: "inlineText", text: "hello" },
              target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
            },
            {
              id: "deep",
              apply: "writeFile",
              source: { type: "inlineText", text: "deep" },
              target: { root: "USER_HOME", path: ".codex/inputs/a/b/c.txt" },
            },
          ],
        },
      });

      await expect(fs.readFile(path.join(home, ".codex", "AGENTS.md"), "utf8")).resolves.toBe("hello");
      await expect(fs.readFile(path.join(home, ".codex", "inputs", "a", "b", "c.txt"), "utf8")).resolves.toBe("deep");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writeFile rejects non-inlineText source", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-agentInputs-"));
    const home = path.join(rootDir, "home-r1");
    await fs.mkdir(home, { recursive: true });

    try {
      const ctx = {
        cfg: { orchestrator_url: "http://localhost", skills_download_max_bytes: 1_000_000 },
        log: vi.fn(),
      } as any;
      const run = { runId: "r1", hostWorkspacePath: path.join(rootDir, "ws-r1"), hostUserHomePath: home } as any;

      await expect(
        applyAgentInputs({
          ctx,
          run,
          manifest: {
            version: 1,
            items: [
              {
                id: "bad",
                apply: "writeFile",
                source: { type: "hostPath", path: home },
                target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
              },
            ],
          },
        }),
      ).rejects.toThrow(/writeFile requires source=inlineText/i);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects USER_HOME apply when hostUserHomePath missing", async () => {
    const ctx = {
      cfg: { orchestrator_url: "http://localhost", skills_download_max_bytes: 1_000_000 },
      log: vi.fn(),
    } as any;
    const run = { runId: "r1", hostWorkspacePath: "D:\\ws", hostUserHomePath: null } as any;

    await expect(
      applyAgentInputs({
        ctx,
        run,
        manifest: {
          version: 1,
          items: [
            {
              id: "agents-md",
              apply: "writeFile",
              source: { type: "inlineText", text: "hello" },
              target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/hostUserHomePath missing/i);
  });

  it("defends against target.path escape (parse + resolveHostTargetPath)", async () => {
    expect(() =>
      parseAgentInputsFromInit({
        agentInputs: {
          version: 1,
          items: [
            {
              id: "escape",
              apply: "writeFile",
              source: { type: "inlineText", text: "x" },
              target: { root: "USER_HOME", path: "../escape.txt" },
            },
          ],
        },
      }),
    ).toThrow(/must not escape root/i);

    const ctx = {
      cfg: { orchestrator_url: "http://localhost", skills_download_max_bytes: 1_000_000 },
      log: vi.fn(),
    } as any;
    const run = { runId: "r1", hostWorkspacePath: "D:\\ws", hostUserHomePath: "D:\\home" } as any;

    await expect(
      applyAgentInputs({
        ctx,
        run,
        manifest: {
          version: 1,
          items: [
            {
              id: "escape",
              apply: "writeFile",
              source: { type: "inlineText", text: "x" },
              target: { root: "USER_HOME", path: "../escape.txt" },
            },
          ],
        },
      }),
    ).rejects.toThrow(/escaped host root/i);
  });

  it("envPatch only allows HOME/USER/LOGNAME", async () => {
    expect(() =>
      parseAgentInputsFromInit({
        agentInputs: { version: 1, envPatch: { PATH: "/tmp" }, items: [] },
      }),
    ).toThrow(/INVALID_AGENT_INPUTS_ENV_PATCH_KEY:PATH/);
  });
});

