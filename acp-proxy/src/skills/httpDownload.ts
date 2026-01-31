import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export async function downloadToFile(opts: {
  url: string;
  destFile: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes?: number;
}): Promise<{ bytes: number }> {
  const destFile = path.resolve(opts.destFile);
  await fsp.mkdir(path.dirname(destFile), { recursive: true });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, opts.timeoutMs));
  (timer as any).unref?.();

  try {
    const maxBytesRaw = Number(opts.maxBytes ?? 0);
    const maxBytes = Number.isFinite(maxBytesRaw) ? Math.max(0, Math.floor(maxBytesRaw)) : 0;

    const res = await fetch(opts.url, {
      headers: opts.headers,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`download failed: ${res.status} ${text}`.trim());
    }
    if (!res.body) throw new Error("download failed: empty body");

    const contentLengthRaw = res.headers.get("content-length")?.trim() ?? "";
    const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN;
    if (maxBytes > 0 && Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`download too large: contentLength=${contentLength} maxBytes=${maxBytes}`);
    }

    const tmp = `${destFile}.tmp-${Math.random().toString(16).slice(2)}`;
    try {
      const out = fs.createWriteStream(tmp);

      let downloaded = 0;
      const limiter =
        maxBytes > 0
          ? new Transform({
              transform(chunk, _enc, cb) {
                downloaded += chunk.length;
                if (downloaded > maxBytes) {
                  try {
                    ctrl.abort();
                  } catch {
                    // ignore
                  }
                  cb(new Error(`download too large: maxBytes=${maxBytes}`));
                  return;
                }
                cb(null, chunk);
              },
            })
          : null;

      const input = Readable.fromWeb(res.body as any);
      if (limiter) {
        await pipeline(input, limiter, out);
      } else {
        await pipeline(input, out);
      }
      await fsp.rename(tmp, destFile);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }

    const stat = await fsp.stat(destFile);
    return { bytes: stat.size };
  } finally {
    clearTimeout(timer);
  }
}
