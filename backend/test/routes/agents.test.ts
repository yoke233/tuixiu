import { describe, expect, it, vi } from "vitest";

import { makeAgentRoutes } from "../../src/routes/agents.js";
import { createHttpServer } from "../test-utils.js";

describe("GET /api/agents", () => {
  it("returns agents from prisma", async () => {
    const server = createHttpServer();
    const prisma = {
      agent: { findMany: vi.fn().mockResolvedValue([{ id: "a1" }]) }
    } as any;

    await server.register(makeAgentRoutes({ prisma }), { prefix: "/api/agents" });

    const res = await server.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { agents: [{ id: "a1" }] } });
    expect(prisma.agent.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" } });
    await server.close();
  });
});
