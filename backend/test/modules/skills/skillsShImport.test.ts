import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  packageSkillsShPrepared,
  prepareSkillsShImport,
} from "../../../src/modules/skills/skillsShImport.js";

type CliRun = (opts: { args: string[]; cwd: string; timeoutMs: number }) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}>;

function makeSkillsCli(runImpl: CliRun) {
  return {
    run: runImpl,
    withTempDir: async <T>(task: (cwd: string) => Promise<T>): Promise<T> => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-cli-"));
      try {
        return await task(dir);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

describe("skillsShImport", () => {
  it("prepares skill with front matter metadata", async () => {
    const cli = makeSkillsCli(async ({ cwd }) => {
      const skillDir = path.join(cwd, ".agents", "skills", "demo-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: "Demo"
description: |
  line1
  line2
tags:
  - Foo
  - bar
---
body`,
        "utf8",
      );
      await fs.writeFile(path.join(skillDir, "index.js"), "console.log('x')", "utf8");
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    });

    const { prepared, cleanup } = await prepareSkillsShImport({
      skillsCli: cli,
      source: { sourceKey: "local:demo", skill: "demo-skill" },
      timeoutMs: 1000,
    });

    expect(prepared.meta.name).toBe("Demo");
    expect(prepared.meta.description).toBe("line1\nline2");
    expect(prepared.meta.tags).toEqual(["foo", "bar"]);
    expect(prepared.fileCount).toBeGreaterThanOrEqual(2);
    expect(prepared.contentHash).toHaveLength(64);
    expect(prepared.manifestJson).toHaveProperty("contentHash", prepared.contentHash);

    await cleanup();
  });

  it("uses fallback name when front matter missing", async () => {
    const cli = makeSkillsCli(async ({ cwd }) => {
      const skillDir = path.join(cwd, ".agents", "skills", "demo-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "body", "utf8");
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    });

    const { prepared, cleanup } = await prepareSkillsShImport({
      skillsCli: cli,
      source: { sourceKey: "local:demo", skill: "demo-skill" },
      timeoutMs: 1000,
    });

    expect(prepared.meta.name).toBe("demo-skill");
    await cleanup();
  });

  it("throws when SKILL.md missing", async () => {
    const cli = makeSkillsCli(async ({ cwd }) => {
      const skillDir = path.join(cwd, ".agents", "skills", "demo-skill");
      await fs.mkdir(skillDir, { recursive: true });
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });

    await expect(
      prepareSkillsShImport({
        skillsCli: cli,
        source: { sourceKey: "local:demo", skill: "demo-skill" },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("SKILL_MD_MISSING");
  });

  it("throws on cli timeout or failure", async () => {
    const timeoutCli = makeSkillsCli(async () => ({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: true,
    }));
    await expect(
      prepareSkillsShImport({
        skillsCli: timeoutCli,
        source: { sourceKey: "local:demo", skill: "demo-skill" },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("SKILLS_CLI_TIMEOUT");

    const failCli = makeSkillsCli(async () => ({
      stdout: "out",
      stderr: "err",
      exitCode: 1,
      timedOut: false,
    }));
    await expect(
      prepareSkillsShImport({
        skillsCli: failCli,
        source: { sourceKey: "local:demo", skill: "demo-skill" },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("SKILLS_CLI_FAILED");
  });

  it("packages prepared skill with store", async () => {
    const cli = makeSkillsCli(async ({ cwd }) => {
      const skillDir = path.join(cwd, ".agents", "skills", "demo-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "body", "utf8");
      await fs.writeFile(path.join(skillDir, "index.js"), "x", "utf8");
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    });

    const { prepared, cleanup } = await prepareSkillsShImport({
      skillsCli: cli,
      source: { sourceKey: "local:demo", skill: "demo-skill" },
      timeoutMs: 1000,
    });

    const packages = {
      putZipFile: async (opts: { contentHash: string; zipFilePath: string }) => {
        const stat = await fs.stat(opts.zipFilePath);
        return {
          contentHash: opts.contentHash,
          storageUri: `local://${opts.contentHash}.zip`,
          filePath: opts.zipFilePath,
          size: stat.size,
        };
      },
      getInfo: async () => null,
    };

    const stored = await packageSkillsShPrepared({ packages, prepared });
    expect(stored.storageUri).toContain(prepared.contentHash);
    expect(stored.packageSize).toBeGreaterThan(0);

    await cleanup();
  });
});
