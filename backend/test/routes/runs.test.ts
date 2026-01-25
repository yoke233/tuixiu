import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createHttpServer } from "../test-utils.js";

describe("Runs routes", () => {
  it("GET /api/runs/:id returns run", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1" }) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { run: { id: "r1" } } });
    await server.close();
  });

  it("GET /api/runs/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(null) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Run 不存在" }
    });
    await server.close();
  });

  it("GET /api/runs/:id/events returns events", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { findMany: vi.fn().mockResolvedValue([{ id: "e1" }]) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/events?limit=3"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { events: [{ id: "e1" }] } });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "00000000-0000-0000-0000-000000000001" },
      orderBy: { timestamp: "desc" },
      take: 3
    });
    await server.close();
  });

  it("POST /api/runs/:id/cancel marks cancelled", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { update: vi.fn().mockResolvedValue({ id: "r2", status: "cancelled" }) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000002/cancel"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r2");
    expect(prisma.run.update).toHaveBeenCalled();
    const call = prisma.run.update.mock.calls[0][0];
    expect(call.where.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(call.data.status).toBe("cancelled");
    expect(call.data.completedAt).toBeInstanceOf(Date);
    await server.close();
  });
});
