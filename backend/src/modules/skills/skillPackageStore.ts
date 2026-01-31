import fs from "node:fs/promises";
import path from "node:path";

function isSafeHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value.trim());
}

export type StoredSkillPackage = {
  contentHash: string;
  storageUri: string;
  filePath: string;
  size: number;
};

export type SkillPackageStore = {
  putZipFile: (opts: { contentHash: string; zipFilePath: string }) => Promise<StoredSkillPackage>;
  getInfo: (opts: { contentHash: string }) => Promise<StoredSkillPackage | null>;
};

export function createLocalSkillPackageStore(opts: {
  rootDir: string;
  basePath: string;
  maxBytes: number;
}): SkillPackageStore {
  const rootDir = path.resolve(opts.rootDir);
  const basePath = opts.basePath.trim().replace(/\/+$/, "") || "/api/acp-proxy/skills/packages";
  const maxBytes = opts.maxBytes;

  async function ensureDir() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  function resolveFilePath(contentHash: string): string {
    if (!isSafeHash(contentHash)) throw new Error("INVALID_HASH");
    return path.join(rootDir, `${contentHash}.zip`);
  }

  async function putZipFile(input: { contentHash: string; zipFilePath: string }): Promise<StoredSkillPackage> {
    if (!isSafeHash(input.contentHash)) throw new Error("INVALID_HASH");
    const zipFilePath = path.resolve(input.zipFilePath);

    await ensureDir();
    const filePath = resolveFilePath(input.contentHash);

    // Content addressed: idempotent write.
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        return {
          contentHash: input.contentHash,
          storageUri: `${basePath}/${encodeURIComponent(input.contentHash)}.zip`,
          filePath,
          size: stat.size,
        };
      }
    } catch {
      // ignore
    }

    const srcStat = await fs.stat(zipFilePath);
    if (!srcStat.isFile()) throw new Error("INVALID_ZIP_FILE");
    if (srcStat.size <= 0) throw new Error("EMPTY_ZIP");
    if (maxBytes > 0 && srcStat.size > maxBytes) {
      const err = new Error("FILE_TOO_LARGE");
      (err as any).maxBytes = maxBytes;
      (err as any).size = srcStat.size;
      throw err;
    }

    await fs.copyFile(zipFilePath, filePath);
    const stat = await fs.stat(filePath);
    return {
      contentHash: input.contentHash,
      storageUri: `${basePath}/${encodeURIComponent(input.contentHash)}.zip`,
      filePath,
      size: stat.size,
    };
  }

  async function getInfo(input: { contentHash: string }): Promise<StoredSkillPackage | null> {
    if (!isSafeHash(input.contentHash)) return null;
    const filePath = resolveFilePath(input.contentHash);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        contentHash: input.contentHash,
        storageUri: `${basePath}/${encodeURIComponent(input.contentHash)}.zip`,
        filePath,
        size: stat.size,
      };
    } catch {
      return null;
    }
  }

  return { putZipFile, getInfo };
}
