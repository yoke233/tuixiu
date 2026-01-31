import { describe, expect, it } from "vitest";

import { makeHealthRoutes } from "../../src/routes/health.js";
import { createHttpServer } from "../test-utils.js";

describe("GET /api/health", () => {
  it("returns ok without auth", async () => {
    const server = createHttpServer();
    await server.register(makeHealthRoutes(), { prefix: "/api" });

    const res = await server.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    await server.close();
  });
});

