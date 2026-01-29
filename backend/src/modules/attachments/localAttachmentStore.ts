import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AttachmentStore, StoredAttachment, StoredAttachmentInfo } from "./attachmentStore.js";

type AttachmentMeta = {
  id: string;
  runId: string;
  mimeType: string;
  size: number;
  sha256: string;
  name?: string | null;
  createdAt: string;
};

function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("data:")) return trimmed;
  const idx = trimmed.indexOf("base64,");
  if (idx < 0) return trimmed;
  return trimmed.slice(idx + "base64,".length);
}

function isSafeSegment(value: string): boolean {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return true;
}

export function createLocalAttachmentStore(opts: { rootDir: string; maxBytes: number }): AttachmentStore {
  const rootDir = path.resolve(opts.rootDir);
  const maxBytes = opts.maxBytes;

  async function ensureDir(p: string) {
    await fs.mkdir(p, { recursive: true });
  }

  function getAttachmentDir(runId: string, id: string): string {
    if (!isSafeSegment(runId) || !isSafeSegment(id)) {
      throw new Error("Invalid attachment path segment");
    }
    return path.join(rootDir, runId, id);
  }

  async function readMeta(metaPath: string): Promise<AttachmentMeta | null> {
    try {
      const raw = await fs.readFile(metaPath, "utf8");
      const parsed = JSON.parse(raw) as AttachmentMeta;
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.id !== "string" || typeof parsed.runId !== "string") return null;
      if (typeof parsed.mimeType !== "string" || typeof parsed.sha256 !== "string") return null;
      if (typeof parsed.size !== "number" || !Number.isFinite(parsed.size) || parsed.size < 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function putFromBase64(input: { runId: string; mimeType: string; base64: string; name?: string | null }): Promise<StoredAttachment> {
      const base64 = stripDataUrlPrefix(input.base64);
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.length) {
        throw new Error("EMPTY_FILE");
      }
      if (maxBytes > 0 && bytes.length > maxBytes) {
        const err = new Error("FILE_TOO_LARGE");
        (err as any).maxBytes = maxBytes;
        (err as any).size = bytes.length;
        throw err;
      }

      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = sha256;
      const runId = input.runId;

      const dir = getAttachmentDir(runId, id);
      const filePath = path.join(dir, "file");
      const metaPath = path.join(dir, "meta.json");

      await ensureDir(dir);
      await fs.writeFile(filePath, bytes);

      const meta: AttachmentMeta = {
        id,
        runId,
        mimeType: input.mimeType,
        size: bytes.length,
        sha256,
        name: input.name ?? null,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

      return {
        id,
        runId,
        mimeType: input.mimeType,
        size: bytes.length,
        sha256,
        uri: `/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(id)}`,
      };
  }

  async function getInfo(opts: { runId: string; id: string }): Promise<StoredAttachmentInfo | null> {
    const dir = getAttachmentDir(opts.runId, opts.id);
    const metaPath = path.join(dir, "meta.json");
    const filePath = path.join(dir, "file");

    const meta = await readMeta(metaPath);
    if (!meta) return null;
    if (meta.runId !== opts.runId || meta.id !== opts.id) return null;

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        id: meta.id,
        runId: meta.runId,
        mimeType: meta.mimeType,
        size: meta.size,
        sha256: meta.sha256,
        filePath,
      };
    } catch {
      return null;
    }
  }

  async function getBytes(opts: { runId: string; id: string }): Promise<Buffer | null> {
    const info = await getInfo(opts);
    if (!info) return null;
    try {
      return await fs.readFile(info.filePath);
    } catch {
      return null;
    }
  }

  return {
    putFromBase64,
    getInfo,
    getBytes,
  };
}
