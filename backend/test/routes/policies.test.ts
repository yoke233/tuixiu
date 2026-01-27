import { describe, expect, it, vi } from "vitest";

import { makePolicyRoutes } from "../../src/routes/policies.js";
import { createHttpServer } from "../test-utils.js";

describe("Policy routes", () => {
  it("GET /api/policies returns default policy when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001", branchProtection: null }),
      },
    } as any;

    await server.register(makePolicyRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/policies?projectId=00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.projectId).toBe("00000000-0000-0000-0000-000000000001");
    expect(body.data.source).toBe("default");
    expect(body.data.policy).toEqual({
      version: 1,
      automation: { autoStartIssue: true, autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
      approvals: { requireForActions: ["merge_pr"], escalateOnSensitivePaths: ["create_pr", "publish_artifact"] },
      sensitivePaths: [],
    });

    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000001" },
      select: { id: true, branchProtection: true },
    });

    await server.close();
  });

  it("PUT /api/policies updates branchProtection.pmPolicy and preserves existing keys", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000001",
          branchProtection: { foo: "bar" },
        }),
        update: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000001" }),
      },
    } as any;

    await server.register(makePolicyRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "PUT",
      url: "/api/policies?projectId=00000000-0000-0000-0000-000000000001",
      payload: { policy: { automation: { autoStartIssue: false }, sensitivePaths: ["backend/prisma/**"] } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        projectId: "00000000-0000-0000-0000-000000000001",
        policy: {
          version: 1,
          automation: { autoStartIssue: false, autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
          approvals: { requireForActions: ["merge_pr"], escalateOnSensitivePaths: ["create_pr", "publish_artifact"] },
          sensitivePaths: ["backend/prisma/**"],
        },
      },
    });

    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-0000-0000-000000000001" },
      data: {
        branchProtection: {
          foo: "bar",
          pmPolicy: {
            version: 1,
            automation: { autoStartIssue: false, autoReview: true, autoCreatePr: true, autoRequestMergeApproval: true },
            approvals: { requireForActions: ["merge_pr"], escalateOnSensitivePaths: ["create_pr", "publish_artifact"] },
            sensitivePaths: ["backend/prisma/**"],
          },
        },
      },
    });

    await server.close();
  });
});

