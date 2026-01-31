import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yazl from "yazl";

async function listFilesRecursive(rootDir: string, dir: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: Array<{ absPath: string; relPath: string }> = [];
  for (const ent of entries) {
    const absPath = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...(await listFilesRecursive(rootDir, absPath)));
      continue;
    }
    if (!ent.isFile()) continue;
    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    out.push({ absPath, relPath });
  }
  return out;
}

export async function zipDirToFile(opts: { dir: string; outFile: string }): Promise<{ bytes: number; fileCount: number }> {
  const dir = path.resolve(opts.dir);
  const outFile = path.resolve(opts.outFile);

  await fsp.mkdir(path.dirname(outFile), { recursive: true });

  const files = await listFilesRecursive(dir, dir);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const zipfile = new (yazl as any).ZipFile();
  for (const f of files) {
    // Normalize zip entries to reduce variability.
    zipfile.addFile(f.absPath, f.relPath, { mtime: new Date(0) });
  }
  zipfile.end();

  const out = fs.createWriteStream(outFile);
  await pipeline(zipfile.outputStream, out);

  const stat = await fsp.stat(outFile);
  return { bytes: stat.size, fileCount: files.length };
}

