import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractZipSafe } from "./zipSafeExtract.js";

function crc32(buf: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (const b of buf) {
    crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function makeZip(files: Array<{ name: string; content: Buffer; externalAttrs?: number }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];

  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name.replace(/\\/g, "/"), "utf8");
    const data = f.content;
    const crc = crc32(data);

    // local file header
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0), // store
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);
    parts.push(localHeader, data);

    // central directory header
    const externalAttrs = f.externalAttrs ?? 0;
    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0), // store
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(externalAttrs >>> 0),
      u32(offset),
      nameBytes,
    ]);
    central.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  const centralDir = Buffer.concat(central);
  parts.push(centralDir);
  const centralSize = centralDir.length;

  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(centralStart),
    u16(0),
  ]);
  parts.push(end);

  return Buffer.concat(parts);
}

describe("skills/zipSafeExtract", () => {
  it("extracts a simple zip", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tuixiu-zip-"));
    const zipFile = path.join(root, "a.zip");
    const outDir = path.join(root, "out");
    try {
      const zip = makeZip([{ name: "SKILL.md", content: Buffer.from("# ok\n", "utf8") }]);
      await writeFile(zipFile, zip);

      await extractZipSafe({ zipFile, outDir });

      const extracted = await readFile(path.join(outDir, "SKILL.md"), "utf8");
      expect(extracted).toBe("# ok\n");
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects ZipSlip paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tuixiu-zip-"));
    const zipFile = path.join(root, "a.zip");
    const outDir = path.join(root, "out");
    try {
      const zip = makeZip([{ name: "../evil.txt", content: Buffer.from("no", "utf8") }]);
      await writeFile(zipFile, zip);
      await expect(extractZipSafe({ zipFile, outDir })).rejects.toThrow(/not allowed|escaped|invalid relative path/);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects symlink entries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tuixiu-zip-"));
    const zipFile = path.join(root, "a.zip");
    const outDir = path.join(root, "out");
    try {
      // symlink unix mode: 0120000
      const externalAttrs = (0o120777 << 16) >>> 0;
      const zip = makeZip([{ name: "link", content: Buffer.from("", "utf8"), externalAttrs }]);
      await writeFile(zipFile, zip);
      await expect(extractZipSafe({ zipFile, outDir })).rejects.toThrow(/symlink is not allowed/);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
