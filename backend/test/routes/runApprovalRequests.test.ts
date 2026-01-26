import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createHttpServer } from "../test-utils.js";

describe("Run approval request routes", () => {
  it("POST /api/runs/:id/request-merge-pr creates approval artifact", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: { id: "i1", title: "t1", projectId: "p1" },
          artifacts: [{ id: "pr-1", runId: "r1", type: "pr", content: { iid: 7 }, createdAt: new Date().toISOString() }],
        }),
      },
      artifact: {
        create: vi.fn().mockResolvedValue({
          id: "ap-1",
          runId: "r1",
          type: "report",
          content: { kind: "approval_request", action: "merge_pr", status: "pending", requestedBy: "user", requestedAt: new Date().toISOString() },
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
    expect(prisma.artifact.create).toHaveBeenCalled();
    const call = prisma.artifact.create.mock.calls[0][0];
    expect(call.data.type).toBe("report");
    expect(call.data.runId).toBe("r1");
    expect(call.data.content.kind).toBe("approval_request");
    expect(call.data.content.action).toBe("merge_pr");
    expect(call.data.content.status).toBe("pending");
    expect(call.data.content.requestedBy).toBe("tester");
    await server.close();
  });

  it("POST /api/runs/:id/request-merge-pr returns existing pending approval", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: { id: "i1", title: "t1", projectId: "p1" },
          artifacts: [
            { id: "ap-1", runId: "r1", type: "report", content: { kind: "approval_request", action: "merge_pr", status: "pending" }, createdAt: new Date().toISOString() },
            { id: "pr-1", runId: "r1", type: "pr", content: { iid: 7 }, createdAt: new Date().toISOString() },
          ],
        }),
      },
      artifact: {
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
    expect(prisma.artifact.create).not.toHaveBeenCalled();
    await server.close();
  });
});

