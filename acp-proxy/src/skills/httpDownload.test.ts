import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadToFile } from "./httpDownload.js";

describe("downloadToFile", () => {
  let tmpDir = "";
  const prevFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "tuixiu-download-"));
  });

  afterEach(async () => {
    globalThis.fetch = prevFetch;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects when Content-Length exceeds maxBytes", async () => {
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-length": "10" } });
    });
    globalThis.fetch = fetchMock as any;

    const destFile = path.join(tmpDir, "out.zip");
    await expect(
      downloadToFile({ url: "http://example.test/file", destFile, timeoutMs: 1_000, maxBytes: 5 }),
    ).rejects.toThrow(/contentLength/i);

    const files = await readdir(tmpDir);
    expect(files).toEqual([]);
  });

  it("cleans tmp file when stream exceeds maxBytes", async () => {
    const fetchMock = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(10));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    const destFile = path.join(tmpDir, "out.zip");
    await expect(
      downloadToFile({ url: "http://example.test/file", destFile, timeoutMs: 1_000, maxBytes: 30 }),
    ).rejects.toThrow(/too large/i);

    const files = await readdir(tmpDir);
    expect(files).toEqual([]);
  });
});

