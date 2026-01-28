import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpServer } from "../test-utils.js";

vi.mock("../../src/services/artifactPublish.js", () => ({
  planArtifactPublish: vi.fn(),
  publishArtifact: vi.fn(),
}));
vi.mock("../../src/services/approvalRequests.js", () => ({
  requestPublishArtifactApproval: vi.fn(),
}));
vi.mock("../../src/services/pm/pmPolicy.js", () => ({
  getPmPolicyFromBranchProtection: vi.fn(),
}));
vi.mock("../../src/services/pm/pmSensitivePaths.js", () => ({
  computeSensitiveHitFromPaths: vi.fn(),
}));

const { makeArtifactRoutes } = await import("../../src/routes/artifacts.js");
const { planArtifactPublish, publishArtifact } = await import("../../src/services/artifactPublish.js");
const { requestPublishArtifactApproval } = await import("../../src/services/approvalRequests.js");
const { getPmPolicyFromBranchProtection } = await import("../../src/services/pm/pmPolicy.js");
const { computeSensitiveHitFromPaths } = await import("../../src/services/pm/pmSensitivePaths.js");

function makePolicy(overrides?: Partial<any>) {
  return {
    policy: {
      sensitivePaths: [],
      approvals: {
        escalateOnSensitivePaths: [],
        requireForActions: [],
      },
      ...overrides,
    },
  };
}

describe("Artifact routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getPmPolicyFromBranchProtection as any).mockReturnValue(makePolicy());
  });

  it("POST /api/artifacts/:id/publish returns NOT_FOUND when artifact missing", async () => {
    const server = createHttpServer();
    const prisma = {
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Artifact 不存在" } });
    expect(planArtifactPublish).not.toHaveBeenCalled();
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(requestPublishArtifactApproval).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/artifacts/:id/publish returns BAD_ARTIFACT when project missing", async () => {
    const server = createHttpServer();
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "a1", run: { issue: { project: null } } }),
      },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_ARTIFACT", message: "Artifact 缺少 project" } });
    expect(planArtifactPublish).not.toHaveBeenCalled();
    expect(publishArtifact).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/artifacts/:id/publish returns plan error when planArtifactPublish fails", async () => {
    (planArtifactPublish as any).mockResolvedValue({ success: false, error: { code: "BAD_PATH", message: "x" } });

    const server = createHttpServer();
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "a1", run: { issue: { project: { branchProtection: "" } } } }),
      },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
      payload: { path: "dist/out.zip" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "BAD_PATH", message: "x" } });
    expect(publishArtifact).not.toHaveBeenCalled();
    expect(requestPublishArtifactApproval).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/artifacts/:id/publish creates approval request when policy requires approval", async () => {
    (getPmPolicyFromBranchProtection as any).mockReturnValue(
      makePolicy({ approvals: { escalateOnSensitivePaths: [], requireForActions: ["publish_artifact"] } }),
    );
    (planArtifactPublish as any).mockResolvedValue({ success: true, data: { path: "dist/out.zip" } });
    (requestPublishArtifactApproval as any).mockResolvedValue({ success: true, data: { approvalRequestId: "ar1" } });

    const server = createHttpServer();
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "a1", run: { issue: { project: { branchProtection: "" } } } }),
      },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
      payload: { path: "dist/out.zip" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("APPROVAL_REQUIRED");

    expect(requestPublishArtifactApproval).toHaveBeenCalledWith({
      prisma,
      artifactId: "00000000-0000-0000-0000-000000000001",
      requestedBy: "api_publish_artifact",
      payload: { path: "dist/out.zip", sensitive: undefined },
    });
    expect(computeSensitiveHitFromPaths).not.toHaveBeenCalled();
    expect(publishArtifact).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/artifacts/:id/publish publishes immediately when approval not required", async () => {
    (planArtifactPublish as any).mockResolvedValue({ success: true, data: { path: "dist/out.zip" } });
    (publishArtifact as any).mockResolvedValue({ success: true, data: { published: true } });

    const server = createHttpServer();
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "a1", run: { issue: { project: { branchProtection: "" } } } }),
      },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
      payload: { path: "dist/out.zip" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { published: true } });
    expect(requestPublishArtifactApproval).not.toHaveBeenCalled();
    expect(publishArtifact).toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/artifacts/:id/publish escalates to approval when sensitive paths hit", async () => {
    const patterns = Array.from({ length: 25 }, (_, i) => `p${i + 1}`);
    const matchedFiles = Array.from({ length: 100 }, (_, i) => `f${i + 1}`);

    (getPmPolicyFromBranchProtection as any).mockReturnValue(
      makePolicy({ sensitivePaths: ["**/*.pem"], approvals: { escalateOnSensitivePaths: ["publish_artifact"], requireForActions: [] } }),
    );
    (planArtifactPublish as any).mockResolvedValue({ success: true, data: { path: "dist/out.zip" } });
    (computeSensitiveHitFromPaths as any).mockReturnValue({ patterns, matchedFiles });
    (requestPublishArtifactApproval as any).mockResolvedValue({ success: true, data: { approvalRequestId: "ar2" } });

    const server = createHttpServer();
    const prisma = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "a1", run: { issue: { project: { branchProtection: "" } } } }),
      },
    } as any;

    await server.register(makeArtifactRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "POST",
      url: "/api/artifacts/00000000-0000-0000-0000-000000000001/publish",
      payload: { path: "dist/out.zip" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("APPROVAL_REQUIRED");

    expect(computeSensitiveHitFromPaths).toHaveBeenCalledWith(["dist/out.zip"], ["**/*.pem"]);
    expect(requestPublishArtifactApproval).toHaveBeenCalledWith({
      prisma,
      artifactId: "00000000-0000-0000-0000-000000000001",
      requestedBy: "api_publish_artifact",
      payload: {
        path: "dist/out.zip",
        sensitive: { patterns: patterns.slice(0, 20), matchedFiles: matchedFiles.slice(0, 60) },
      },
    });
    expect(publishArtifact).not.toHaveBeenCalled();

    await server.close();
  });
});

