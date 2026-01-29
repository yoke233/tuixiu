import { describe, expect, it, vi } from "vitest";

import { createHttpServer } from "../test-utils.js";

vi.mock("../../src/modules/pm/pmAutoReviewRun.js", () => ({
  autoReviewRunForPm: vi.fn().mockResolvedValue({
    success: true,
    data: { runId: "00000000-0000-0000-0000-000000000001", artifactId: "art-1", report: { kind: "auto_review" } },
  }),
}));

const { makePmRoutes } = await import("../../src/routes/pm.js");
const { autoReviewRunForPm } = await import("../../src/modules/pm/pmAutoReviewRun.js");

describe("PM auto-review route", () => {
  it("POST /api/pm/runs/:id/auto-review calls autoReviewRunForPm", async () => {
    const server = createHttpServer();
    const prisma = {} as any;
    const pm = {
      analyze: vi.fn(),
      dispatch: vi.fn(),
      triggerAutoStart: vi.fn(),
    } as any;

    await server.register(makePmRoutes({ prisma, pm }), { prefix: "/api/pm" });

    const res = await server.inject({
      method: "POST",
      url: "/api/pm/runs/00000000-0000-0000-0000-000000000001/auto-review",
    });

    expect(res.statusCode).toBe(200);
    expect(autoReviewRunForPm).toHaveBeenCalledWith({ prisma }, "00000000-0000-0000-0000-000000000001");
    expect(res.json()).toEqual({
      success: true,
      data: { runId: "00000000-0000-0000-0000-000000000001", artifactId: "art-1", report: { kind: "auto_review" } },
    });

    await server.close();
  });
});

