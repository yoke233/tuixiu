import { describe, expect, it, vi } from "vitest";
import cookie from "@fastify/cookie";

import { makeAuthRoutes } from "../../src/routes/auth.js";
import { createHttpServer } from "../test-utils.js";

describe("Auth routes", () => {
  it("POST /api/auth/bootstrap creates first admin", async () => {
    const server = createHttpServer();
    await server.register(cookie);
    const prisma = {
      user: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: "u1", username: "admin", role: "admin", passwordHash: "x" }),
      },
    } as any;

    const auth = { authenticate: vi.fn(), requireRoles: vi.fn(), sign: vi.fn().mockReturnValue("tok") } as any;
    await server.register(
      makeAuthRoutes({ prisma, auth, tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 } }),
      { prefix: "/api/auth" },
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { username: "Admin", password: "123456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { user: { id: "u1", username: "admin", role: "admin" } },
    });
    expect(res.headers["set-cookie"]).toBeTruthy();
    expect(String(res.headers["set-cookie"])).toMatch(/tuixiu_access=/);
    expect(String(res.headers["set-cookie"])).toMatch(/tuixiu_refresh=/);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly/i);
    await server.close();
  });

  it("POST /api/auth/bootstrap returns ALREADY_BOOTSTRAPPED when users exist", async () => {
    const server = createHttpServer();
    const prisma = {
      user: { count: vi.fn().mockResolvedValue(1) },
    } as any;
    const auth = { authenticate: vi.fn(), requireRoles: vi.fn(), sign: vi.fn() } as any;
    await server.register(
      makeAuthRoutes({ prisma, auth, tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 } }),
      { prefix: "/api/auth" },
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      payload: { username: "admin", password: "123456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "ALREADY_BOOTSTRAPPED", message: "已存在用户，无法 bootstrap" },
    });
    await server.close();
  });

  it("POST /api/auth/login returns BAD_CREDENTIALS when user missing", async () => {
    const server = createHttpServer();
    const prisma = { user: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    const auth = { authenticate: vi.fn(), requireRoles: vi.fn(), sign: vi.fn() } as any;
    await server.register(
      makeAuthRoutes({ prisma, auth, tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 } }),
      { prefix: "/api/auth" },
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "u", password: "p" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_CREDENTIALS", message: "用户名或密码错误" } });
    await server.close();
  });
});
