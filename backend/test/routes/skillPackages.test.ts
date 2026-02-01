import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { makeSkillPackageRoutes } from "../../src/routes/skillPackages.js";
import { createHttpServer } from "../test-utils.js";

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-pkg-"));
  try {
    return await task(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("Skill package routes", () => {
  it("GET /skills/packages/:hash.zip requires proxy auth", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const packages = { getInfo: vi.fn() } as any;

    await server.register(makeSkillPackageRoutes({ packages }), { prefix: "/api/acp-proxy" });

    const resNoAuth = await server.inject({
      method: "GET",
      url: "/api/acp-proxy/skills/packages/" + "a".repeat(64) + ".zip",
    });
    expect(resNoAuth.statusCode).toBe(401);

    const token = (auth as any).sign({ type: "pm" });
    const resForbidden = await server.inject({
      method: "GET",
      url: "/api/acp-proxy/skills/packages/" + "a".repeat(64) + ".zip",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(resForbidden.statusCode).toBe(403);

    await server.close();
  });

  it("returns 404 when package missing", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const packages = { getInfo: vi.fn().mockResolvedValue(null) } as any;

    await server.register(makeSkillPackageRoutes({ packages }), { prefix: "/api/acp-proxy" });

    const token = (auth as any).sign({ type: "acp_proxy" });
    const res = await server.inject({
      method: "GET",
      url: "/api/acp-proxy/skills/packages/" + "a".repeat(64) + ".zip",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "技能包不存在" } });

    await server.close();
  });

  it("serves package with etag and supports 304", async () => {
    await withTempDir(async (dir) => {
      const server = createHttpServer();
      const auth = await registerAuth(server, { jwtSecret: "secret" });
      const contentHash = "b".repeat(64);
      const filePath = path.join(dir, "pkg.zip");
      await fs.writeFile(filePath, "zip", "utf8");

      const packages = {
        getInfo: vi.fn().mockResolvedValue({
          contentHash,
          storageUri: "local",
          filePath,
          size: 3,
        }),
      } as any;

      await server.register(makeSkillPackageRoutes({ packages }), { prefix: "/api/acp-proxy" });

      const token = (auth as any).sign({ type: "acp_proxy" });
      const res = await server.inject({
        method: "GET",
        url: `/api/acp-proxy/skills/packages/${contentHash}.zip`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["etag"]).toBe(`"${contentHash}"`);
      expect(res.headers["cache-control"]).toContain("immutable");

      const res304 = await server.inject({
        method: "GET",
        url: `/api/acp-proxy/skills/packages/${contentHash}.zip`,
        headers: { authorization: `Bearer ${token}`, "if-none-match": `"${contentHash}"` },
      });
      expect(res304.statusCode).toBe(304);

      await server.close();
    });
  });
});
