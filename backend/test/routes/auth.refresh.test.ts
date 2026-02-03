import { describe, expect, it, vi } from "vitest";
import cookie from "@fastify/cookie";

import { makeAuthRoutes } from "../../src/routes/auth.js";
import { registerAuth } from "../../src/auth.js";
import { createHttpServer } from "../test-utils.js";

function pickSetCookie(res: any, name: string): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : [raw].filter(Boolean);
  const hit = list.find((s: string) => String(s).startsWith(name + "="));
  if (!hit) throw new Error("missing set-cookie: " + name);
  return String(hit);
}

describe("Auth refresh", () => {
  it("POST /api/auth/refresh issues new access cookie", async () => {
    const server = createHttpServer();
    await server.register(cookie);
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      user: { count: vi.fn().mockResolvedValue(1) },
    } as any;

    await server.register(
      makeAuthRoutes({
        prisma,
        auth,
        tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 },
        cookie: { secure: false },
      }),
      { prefix: "/api/auth" },
    );

    const refresh = auth.sign(
      { userId: "u1", username: "u1", role: "admin", tokenType: "refresh" },
      { expiresIn: 3600 },
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: { cookie: `tuixiu_refresh=${refresh}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    expect(pickSetCookie(res, "tuixiu_access")).toMatch(/HttpOnly/i);

    await server.close();
  });

  it("POST /api/auth/logout clears access+refresh cookies", async () => {
    const server = createHttpServer();
    await server.register(cookie);
    const auth = await registerAuth(server, { jwtSecret: "secret" });
    const prisma = { user: { count: vi.fn().mockResolvedValue(1) } } as any;
    await server.register(
      makeAuthRoutes({
        prisma,
        auth,
        tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 },
        cookie: { secure: false },
      }),
      { prefix: "/api/auth" },
    );

    const res = await server.inject({ method: "POST", url: "/api/auth/logout", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/tuixiu_access=;/);
    expect(String(res.headers["set-cookie"])).toMatch(/tuixiu_refresh=;/);
    await server.close();
  });
});
