import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createHttpServer } from "../test-utils.js";

describe("Run approval request routes", () => {
  it("POST /api/runs/:id/request-merge-pr creates approval row", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrUrl: "https://gitlab.example.com/group/repo/-/merge_requests/7",
          issue: { id: "i1", title: "t1", projectId: "p1" },
          artifacts: [],
        }),
      },
      approval: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "ap-1",
          runId: "r1",
          action: "merge_pr",
          status: "pending",
          requestedBy: "tester",
          requestedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }),
      },
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/request-merge-pr",
      payload: { requestedBy: "tester", squash: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(prisma.approval.create).toHaveBeenCalled();
    const call = prisma.approval.create.mock.calls[0][0];
    expect(call.data.runId).toBe("r1");
    expect(call.data.action).toBe("merge_pr");
    expect(call.data.status).toBe("pending");
    expect(call.data.requestedBy).toBe("tester");
    await server.close();
  });

  it("POST /api/runs/:id/request-merge-pr returns existing pending approval", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          scmPrUrl: "https://gitlab.example.com/group/repo/-/merge_requests/7",
          issue: { id: "i1", title: "t1", projectId: "p1" },
          artifacts: [],
        }),
      },
      approval: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ap-1",
          runId: "r1",
          action: "merge_pr",
          status: "pending",
          requestedBy: "user",
          requestedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }),
        create: vi.fn(),
      },
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/request-merge-pr",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.approval.id).toBe("ap-1");
    expect(prisma.approval.create).not.toHaveBeenCalled();
    await server.close();
  });
});
