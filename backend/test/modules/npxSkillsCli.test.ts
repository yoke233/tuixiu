import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn((_cmd: string, _args: string[]) => {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  queueMicrotask(() => {
    proc.emit("exit", 0);
    proc.stdout.end();
    proc.stderr.end();
  });
  return proc;
});

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { createNpxSkillsCliRunner } = await import("../../src/modules/skills/npxSkillsCli.js");

describe("createNpxSkillsCliRunner", () => {
  it("spawns via cmd.exe on Windows", async () => {
    const runner = createNpxSkillsCliRunner({ npxPackageSpec: "skills@0.0.0", defaultTimeoutMs: 1_000 });
    const cwd = await mkdtemp(path.join(tmpdir(), "tuixiu-skills-cli-test-"));
    try {
      const res = await runner.run({ args: ["find", "react"], cwd, timeoutMs: 1_000 });
      expect(res.exitCode).toBe(0);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args] = spawnMock.mock.calls[0] ?? [];

      if (process.platform === "win32") {
        expect(cmd).toBe(String(process.env.ComSpec ?? "").trim() || "cmd.exe");
        expect(args.slice(0, 4)).toEqual(["/d", "/s", "/c", "npx"]);
      } else {
        expect(cmd).toBe("npx");
      }

      expect(args).toEqual(expect.arrayContaining(["--yes", "skills@0.0.0", "find", "react"]));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

