import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type ListedFile = { relPath: string; absPath: string; size: number };

async function listFilesRecursive(rootDir: string, dir: string): Promise<ListedFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: ListedFile[] = [];
  for (const ent of entries) {
    const absPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(rootDir, absPath)));
      continue;
    }
    if (!ent.isFile()) continue;
    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    const stat = await fs.stat(absPath);
    out.push({ relPath, absPath, size: stat.size });
  }
  return out;
}

export async function computeSkillDirContentHash(opts: {
  rootDir: string;
}): Promise<{ contentHash: string; totalBytes: number; fileCount: number; files: string[] }> {
  const rootDir = path.resolve(opts.rootDir);
  const files = await listFilesRecursive(rootDir, rootDir);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  for (const f of files) {
    // Normalize to a stable sequence: path + NUL + bytes + NUL.
    hash.update(f.relPath, "utf8");
    hash.update("\0", "utf8");
    const bytes = await fs.readFile(f.absPath);
    hash.update(bytes);
    hash.update("\0", "utf8");
    totalBytes += bytes.length;
  }

  return {
    contentHash: hash.digest("hex"),
    totalBytes,
    fileCount: files.length,
    files: files.map((f) => f.relPath),
  };
}

