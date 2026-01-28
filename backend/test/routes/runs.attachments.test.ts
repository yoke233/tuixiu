import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createLocalAttachmentStore } from "../../src/services/attachments/localAttachmentStore.js";
import { createHttpServer } from "../test-utils.js";

describe("Runs attachments routes", () => {
  it("POST/GET /api/runs/:id/attachments stores and serves image", async () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-attachments-"));

    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: runId }) },
    } as any;
    const attachments = createLocalAttachmentStore({ rootDir: tmp, maxBytes: 1024 * 1024 });

    await server.register(makeRunRoutes({ prisma, attachments }), { prefix: "/api/runs" });

    try {
      const bytes = Buffer.from("hello");
      const resUpload = await server.inject({
        method: "POST",
        url: `/api/runs/${runId}/attachments`,
        payload: { mimeType: "image/png", base64: bytes.toString("base64"), name: "x.png" },
      });
      expect(resUpload.statusCode).toBe(200);
      const uploadBody = resUpload.json() as any;
      expect(uploadBody.success).toBe(true);
      expect(uploadBody.data.attachment.runId).toBe(runId);
      expect(uploadBody.data.attachment.mimeType).toBe("image/png");
      expect(uploadBody.data.attachment.uri).toContain(`/runs/${runId}/attachments/`);

      const uri = String(uploadBody.data.attachment.uri);
      const resGet = await server.inject({ method: "GET", url: `/api${uri}` });
      expect(resGet.statusCode).toBe(200);
      expect(String(resGet.headers["content-type"] ?? "")).toContain("image/png");

      const payload = (resGet as any).rawPayload ? Buffer.from((resGet as any).rawPayload) : Buffer.from(resGet.payload);
      expect(payload).toEqual(bytes);
    } finally {
      await server.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/attachments rejects non-image mimeType", async () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-attachments-"));

    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: runId }) },
    } as any;
    const attachments = createLocalAttachmentStore({ rootDir: tmp, maxBytes: 1024 * 1024 });

    await server.register(makeRunRoutes({ prisma, attachments }), { prefix: "/api/runs" });

    try {
      const bytes = Buffer.from("hello");
      const res = await server.inject({
        method: "POST",
        url: `/api/runs/${runId}/attachments`,
        payload: { mimeType: "text/plain", base64: bytes.toString("base64") },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        success: false,
        error: { code: "UNSUPPORTED_MIME", message: "本期仅支持图片上传" },
      });
    } finally {
      await server.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("POST /api/runs/:id/attachments rejects too large payload", async () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-attachments-"));

    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: runId }) },
    } as any;
    const attachments = createLocalAttachmentStore({ rootDir: tmp, maxBytes: 3 });

    await server.register(makeRunRoutes({ prisma, attachments }), { prefix: "/api/runs" });

    try {
      const bytes = Buffer.from("hello");
      const res = await server.inject({
        method: "POST",
        url: `/api/runs/${runId}/attachments`,
        payload: { mimeType: "image/png", base64: bytes.toString("base64") },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as any;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("FILE_TOO_LARGE");
    } finally {
      await server.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

