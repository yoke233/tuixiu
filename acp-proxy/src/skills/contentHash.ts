import crypto from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

type ListedFile = { relPath: string; absPath: string };

async function listFilesRecursive(rootDir: string, dir: string): Promise<ListedFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: ListedFile[] = [];
  for (const ent of entries) {
    const absPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(rootDir, absPath)));
      continue;
    }
    if (!ent.isFile()) continue;
    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    out.push({ relPath, absPath });
  }
  return out;
}

export async function computeContentHashFromDir(rootDir: string): Promise<{ contentHash: string; fileCount: number; totalBytes: number }> {
  const resolvedRoot = path.resolve(rootDir);
  const files = await listFilesRecursive(resolvedRoot, resolvedRoot);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  for (const f of files) {
    hash.update(f.relPath, "utf8");
    hash.update("\0", "utf8");
    const bytes = await readFile(f.absPath);
    hash.update(bytes);
    hash.update("\0", "utf8");
    totalBytes += bytes.length;
  }

  return { contentHash: hash.digest("hex"), fileCount: files.length, totalBytes };
}

export async function ensureHasSkillMd(dir: string): Promise<void> {
  const p = path.join(dir, "SKILL.md");
  const s = await stat(p);
  if (!s.isFile()) throw new Error("SKILL_MD_MISSING");
}

