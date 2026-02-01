import { describe, expect, it, vi } from "vitest";

import { resolveExecutionProfile } from "../../src/utils/executionProfile.js";

describe("executionProfile", () => {
  it("resolves by precedence task > role > project > platform", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          if (where?.id === "task") return { id: "task", key: "task-profile" };
          if (where?.id === "role") return { id: "role", key: "role-profile" };
          if (where?.id === "project") return { id: "project", key: "project-profile" };
          if (where?.key === "platform") return { id: "platform", key: "platform-profile" };
          return null;
        }),
      },
    } as any;

    const res = await resolveExecutionProfile({
      prisma,
      platformProfileKey: "platform",
      taskProfileId: "task",
      roleProfileId: "role",
      projectProfileId: "project",
    });

    expect(res?.id).toBe("task");
    expect(res?.source).toBe("task");
  });

  it("falls back to platform key when ids missing", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "platform", key: "platform-profile" }),
      },
    } as any;

    const res = await resolveExecutionProfile({
      prisma,
      platformProfileKey: "platform",
    });

    expect(res?.id).toBe("platform");
    expect(res?.source).toBe("platform");
  });

  it("returns null when no profile matches", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as any;

    const res = await resolveExecutionProfile({
      prisma,
      platformProfileKey: "missing",
      taskProfileId: "task",
      roleProfileId: "role",
      projectProfileId: "project",
    });

    expect(res).toBeNull();
    expect(prisma.executionProfile.findUnique).toHaveBeenCalledTimes(4);
  });

  it("skips platform lookup when platform key missing", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: "role", key: "role-profile" }),
      },
    } as any;

    const res = await resolveExecutionProfile({
      prisma,
      platformProfileKey: null,
      roleProfileId: "role",
    });

    expect(res?.id).toBe("role");
    expect(res?.source).toBe("role");
    expect(prisma.executionProfile.findUnique).toHaveBeenCalledTimes(1);
  });

  it("propagates prisma errors", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockRejectedValue(new Error("db down")),
      },
    } as any;

    await expect(
      resolveExecutionProfile({
        prisma,
        taskProfileId: "task",
      }),
    ).rejects.toThrow("db down");
  });

  it("propagates errors on later lookup", async () => {
    const prisma = {
      executionProfile: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          if (where?.id === "task") return null;
          throw new Error("role lookup failed");
        }),
      },
    } as any;

    await expect(
      resolveExecutionProfile({
        prisma,
        taskProfileId: "task",
        roleProfileId: "role",
      }),
    ).rejects.toThrow("role lookup failed");
  });
});
