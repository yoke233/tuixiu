import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import yauzl from "yauzl";

function normalizeZipPath(fileName: string): string {
  return String(fileName ?? "").replace(/\\/g, "/");
}

function isZipSlipPath(p: string): boolean {
  const normalized = path.posix.normalize(p);
  if (!normalized || normalized === "." || normalized === "..") return true;
  if (normalized.startsWith("../") || normalized.includes("/../")) return true;
  if (normalized.startsWith("/")) return true;
  if (/^[A-Za-z]:\//.test(normalized)) return true;
  return false;
}

function isSymlinkEntry(entry: any): boolean {
  const attr = typeof entry?.externalFileAttributes === "number" ? entry.externalFileAttributes : 0;
  const unixMode = (attr >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

export async function extractZipSafe(opts: {
  zipFile: string;
  outDir: string;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}): Promise<void> {
  const zipFile = path.resolve(opts.zipFile);
  const outDir = path.resolve(opts.outDir);
  await fsp.mkdir(outDir, { recursive: true });

  const maxEntries = Number.isFinite(opts.maxEntries as number) ? Math.max(1, Number(opts.maxEntries)) : 5_000;
  const maxTotalBytes =
    Number.isFinite(opts.maxTotalBytes as number) ? Math.max(1, Number(opts.maxTotalBytes)) : 100 * 1024 * 1024;
  const maxFileBytes =
    Number.isFinite(opts.maxFileBytes as number) ? Math.max(1, Number(opts.maxFileBytes)) : 20 * 1024 * 1024;

  await new Promise<void>((resolve, reject) => {
    (yauzl as any).open(
      zipFile,
      { lazyEntries: true, autoClose: true },
      (err: any, zip: any) => {
        if (err || !zip) {
          reject(err ?? new Error("zip open failed"));
          return;
        }

        const done = (e?: any) => {
          try {
            zip.close();
          } catch {
            // ignore
          }
          if (e) reject(e);
          else resolve();
        };

        let entryCount = 0;
        let totalUncompressed = 0;

        zip.readEntry();
        zip.on("entry", (entry: any) => {
          entryCount += 1;
          if (entryCount > maxEntries) {
            done(new Error(`zip too many entries: maxEntries=${maxEntries}`));
            return;
          }

          const rawName = normalizeZipPath(String(entry?.fileName ?? ""));
          if (!rawName) {
            done(new Error("zip entry filename empty"));
            return;
          }

          if (isZipSlipPath(rawName)) {
            done(new Error(`zip entry path is not allowed: ${rawName}`));
            return;
          }

          if (isSymlinkEntry(entry)) {
            done(new Error(`zip entry symlink is not allowed: ${rawName}`));
            return;
          }

          const isDir = rawName.endsWith("/");
          const fileBytesRaw = Number(entry?.uncompressedSize ?? 0);
          const fileBytes = Number.isFinite(fileBytesRaw) ? Math.max(0, Math.floor(fileBytesRaw)) : 0;
          if (!isDir) {
            if (fileBytes > maxFileBytes) {
              done(new Error(`zip entry too large: ${rawName} size=${fileBytes} maxFileBytes=${maxFileBytes}`));
              return;
            }
            totalUncompressed += fileBytes;
            if (totalUncompressed > maxTotalBytes) {
              done(new Error(`zip too large: total=${totalUncompressed} maxTotalBytes=${maxTotalBytes}`));
              return;
            }
          }
          const targetPath = path.resolve(path.join(outDir, rawName));
          if (!targetPath.startsWith(outDir + path.sep) && targetPath !== outDir) {
            done(new Error(`zip entry escaped output dir: ${rawName}`));
            return;
          }

          if (isDir) {
            fsp
              .mkdir(targetPath, { recursive: true })
              .then(() => zip.readEntry())
              .catch((e) => done(e));
            return;
          }

          fsp
            .mkdir(path.dirname(targetPath), { recursive: true })
            .then(() => {
              zip.openReadStream(entry, (e: any, readStream: any) => {
                if (e || !readStream) {
                  done(e ?? new Error("zip read stream failed"));
                  return;
                }
                const out = fs.createWriteStream(targetPath, { flags: "wx" });
                pipeline(readStream, out)
                  .then(() => zip.readEntry())
                  .catch((pipeErr) => done(pipeErr));
              });
            })
            .catch((mkdirErr) => done(mkdirErr));
        });

        zip.on("end", () => done());
        zip.on("error", (e: any) => done(e));
      },
    );
  });
}
