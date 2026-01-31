import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SkillPackageStore } from "./skillPackageStore.js";
import type { SkillsCliRunner, SkillsCliRunResult } from "./npxSkillsCli.js";
import { computeSkillDirContentHash } from "./skillDirHash.js";
import { parseSkillFrontMatter, sanitizeSkillText, sanitizeTags } from "./skillFrontMatter.js";
import type { SkillsShRef } from "./skillsSh.js";
import { zipDirToFile } from "./zipDir.js";

export type SkillsShImportMode = "dry-run" | "new-skill" | "new-version";

export type SkillsShPrepared = {
  source: SkillsShRef;
  skillDir: string;
  cli: SkillsCliRunResult;
  contentHash: string;
  totalBytes: number;
  fileCount: number;
  files: string[];
  manifestJson: Record<string, unknown>;
  meta: { name: string; description: string | null; tags: string[] };
};

async function ensureFileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function writeJsonFile(p: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2);
  await fs.writeFile(p, text, "utf8");
}

export async function prepareSkillsShImport(opts: {
  skillsCli: SkillsCliRunner;
  source: SkillsShRef;
  timeoutMs: number;
}): Promise<{ prepared: SkillsShPrepared; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skills-import-"));
  const cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // Ensure project scope to avoid leaking to global ~/.agents/skills
    await writeJsonFile(path.join(tmpDir, "package.json"), {
      name: "tuixiu-skill-import-tmp",
      private: true,
    });

    const cli = await opts.skillsCli.run({
      args: ["add", opts.source.sourceKey, "-y"],
      cwd: tmpDir,
      timeoutMs: opts.timeoutMs,
    });
    if (cli.timedOut) throw new Error("SKILLS_CLI_TIMEOUT");
    if (cli.exitCode !== 0) {
      const err = new Error("SKILLS_CLI_FAILED");
      (err as any).details = { exitCode: cli.exitCode, stderr: cli.stderr, stdout: cli.stdout };
      throw err;
    }

    const skillDir = path.join(tmpDir, ".agents", "skills", opts.source.skill);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!(await ensureFileExists(skillMdPath))) {
      const err = new Error("SKILL_MD_MISSING");
      (err as any).skillDir = skillDir;
      throw err;
    }

    const skillMdRaw = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontMatter(skillMdRaw);
    const fmObj = fm.frontMatter ?? {};

    const name =
      sanitizeSkillText((fmObj as any).name, 200) ??
      sanitizeSkillText(opts.source.skill, 200) ??
      opts.source.skill;
    const description = sanitizeSkillText((fmObj as any).description, 4000);
    const tags = sanitizeTags((fmObj as any).tags);

    const hashed = await computeSkillDirContentHash({ rootDir: skillDir });

    const manifestJson: Record<string, unknown> = {
      source: opts.source,
      skillDir: ".agents/skills/" + opts.source.skill,
      contentHash: hashed.contentHash,
      fileCount: hashed.fileCount,
      totalBytes: hashed.totalBytes,
      files: hashed.files,
      frontMatter: fmObj,
      rawFrontMatter: fm.rawFrontMatter,
    };

    return {
      prepared: {
        source: opts.source,
        skillDir,
        cli,
        contentHash: hashed.contentHash,
        totalBytes: hashed.totalBytes,
        fileCount: hashed.fileCount,
        files: hashed.files,
        manifestJson,
        meta: { name, description, tags },
      },
      cleanup,
    };
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }
}

export async function packageSkillsShPrepared(opts: {
  packages: SkillPackageStore;
  prepared: SkillsShPrepared;
}): Promise<{ storageUri: string; packageSize: number }> {
  const zipFile = path.join(opts.prepared.skillDir, "..", `skill-${opts.prepared.contentHash}.zip`);
  const zipped = await zipDirToFile({ dir: opts.prepared.skillDir, outFile: zipFile });
  const stored = await opts.packages.putZipFile({ contentHash: opts.prepared.contentHash, zipFilePath: zipFile });
  return { storageUri: stored.storageUri, packageSize: zipped.bytes };
}

