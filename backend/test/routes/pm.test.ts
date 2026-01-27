import { describe, expect, it, vi } from "vitest";

import { makePmRoutes } from "../../src/routes/pm.js";
import { createHttpServer } from "../test-utils.js";

describe("PM routes", () => {
  it("POST /api/pm/issues/:id/analyze returns analysis", async () => {
    const server = createHttpServer();
    const prisma = {} as any;
    const pm = {
      analyze: vi.fn().mockResolvedValue({
        ok: true,
        analysis: { summary: "s", risk: "low", questions: [], recommendedRoleKey: null, recommendedAgentId: null },
        meta: { source: "fallback" },
      }),
      dispatch: vi.fn(),
      triggerAutoStart: vi.fn(),
    } as any;

    await server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });

    const res = await server.inject({
      method: "POST",
      url: "/api/pm/issues/00000000-0000-0000-0000-000000000001/analyze",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        analysis: { summary: "s", risk: "low", questions: [], recommendedRoleKey: null, recommendedAgentId: null },
        meta: { source: "fallback" },
      },
    });
    await server.close();
  });

  it("POST /api/pm/issues/:id/analyze returns error when analyze failed", async () => {
    const server = createHttpServer();
    const prisma = {} as any;
    const pm = {
      analyze: vi.fn().mockResolvedValue({ ok: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } }),
      dispatch: vi.fn(),
      triggerAutoStart: vi.fn(),
    } as any;

    await server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });

    const res = await server.inject({
      method: "POST",
      url: "/api/pm/issues/00000000-0000-0000-0000-000000000001/analyze",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Issue 不存在" } });
    await server.close();
  });

  it("POST /api/pm/issues/:id/dispatch returns pm dispatch result", async () => {
    const server = createHttpServer();
    const prisma = {} as any;
    const pm = {
      analyze: vi.fn(),
      dispatch: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      triggerAutoStart: vi.fn(),
    } as any;

    await server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });

    const res = await server.inject({
      method: "POST",
      url: "/api/pm/issues/00000000-0000-0000-0000-000000000001/dispatch",
      payload: { reason: "manual" },
    });

    expect(res.statusCode).toBe(200);
    expect(pm.dispatch).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001", "manual");
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    await server.close();
  });
});
