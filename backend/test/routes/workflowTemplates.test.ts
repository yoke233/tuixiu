import { describe, expect, it, vi } from "vitest";

import { makeWorkflowTemplateRoutes } from "../../src/routes/workflowTemplates.js";
import { createHttpServer } from "../test-utils.js";

describe("Workflow template routes", () => {
  it("GET /api/workflow-templates returns default when project has no taskTemplates", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "p1", branchProtection: null }),
      },
    } as any;

    await server.register(makeWorkflowTemplateRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "GET",
      url: "/api/workflow-templates?projectId=00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { projectId: "p1", taskTemplates: {}, source: "default" },
    });
    await server.close();
  });

  it("PUT /api/workflow-templates validates and merges into branchProtection", async () => {
    const server = createHttpServer();
    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "p1",
          branchProtection: { pmPolicy: { version: 1 } },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await server.register(makeWorkflowTemplateRoutes({ prisma }), { prefix: "/api" });

    const res = await server.inject({
      method: "PUT",
      url: "/api/workflow-templates?projectId=00000000-0000-0000-0000-000000000001",
      payload: {
        taskTemplates: {
          "custom.hello": {
            displayName: "Hello",
            steps: [{ key: "dev.implement", kind: "dev.implement", executorType: "agent" }],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        projectId: "p1",
        taskTemplates: {
          "custom.hello": {
            displayName: "Hello",
            steps: [{ key: "dev.implement", kind: "dev.implement", executorType: "agent" }],
          },
        },
      },
    });

    expect(prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "00000000-0000-0000-0000-000000000001" },
        data: {
          branchProtection: {
            pmPolicy: { version: 1 },
            taskTemplates: {
              "custom.hello": {
                displayName: "Hello",
                steps: [{ key: "dev.implement", kind: "dev.implement", executorType: "agent" }],
              },
            },
          },
        },
      }),
    );

    await server.close();
  });
});

