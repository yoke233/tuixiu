import { describe, expect, it } from "vitest";

import { registerAuth } from "../../src/auth.js";
import { createHttpServer } from "../test-utils.js";

describe("registerAuth", () => {
  it("authenticate returns 401 when missing token", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    server.get(
      "/private",
      {
        preHandler: auth.authenticate,
      },
      async () => ({ success: true }),
    );

    const res = await server.inject({ method: "GET", url: "/private" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: { code: "UNAUTHORIZED", message: "未登录" } });
    await server.close();
  });

  it("authenticate allows request with valid token", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    server.get(
      "/private",
      {
        preHandler: auth.authenticate,
      },
      async () => ({ success: true }),
    );

    const token = auth.sign({ userId: "u1", username: "u1", role: "admin" });
    const res = await server.inject({
      method: "GET",
      url: "/private",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    await server.close();
  });

  it("requireRoles returns 403 when role not allowed", async () => {
    const server = createHttpServer();
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    server.get(
      "/admin",
      {
        preHandler: auth.requireRoles(["admin"]),
      },
      async () => ({ ok: true }),
    );

    const token = auth.sign({ userId: "u1", username: "u1", role: "pm" });
    const res = await server.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, error: { code: "FORBIDDEN", message: "无权限" } });
    await server.close();
  });
});

