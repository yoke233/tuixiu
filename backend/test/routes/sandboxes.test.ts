import { describe, expect, it, vi } from "vitest";

import { makeSandboxRoutes } from "../../src/routes/sandboxes.js";
import { createHttpServer } from "../test-utils.js";

describe("Sandboxes admin routes", () => {
  it("GET /api/admin/sandboxes returns sandbox list", async () => {
    const server = createHttpServer();

    const prisma = {
      sandboxInstance: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([
          {
            proxyId: "proxy-1",
            runId: "r1",
            instanceName: "tuixiu-run-r1",
            provider: "container_oci",
            runtime: "docker",
            status: "running",
            lastSeenAt: new Date("2026-01-28T12:00:00.000Z"),
            lastError: null,
            run: {
              id: "r1",
              issueId: "i1",
              taskId: "t1",
              stepId: "s1",
              keepaliveTtlSeconds: 1800,
              sandboxStatus: "running",
              sandboxLastSeenAt: new Date("2026-01-28T12:00:00.000Z"),
              sandboxLastError: null,
            },
          },
        ]),
      },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent: vi.fn() }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "GET",
      url: "/api/admin/sandboxes?proxyId=proxy-1&status=running&limit=10&offset=0",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        total: 1,
        limit: 10,
        offset: 0,
        sandboxes: [
          {
            proxyId: "proxy-1",
            runId: "r1",
            instanceName: "tuixiu-run-r1",
            provider: "container_oci",
            runtime: "docker",
            sandboxStatus: "running",
            sandboxLastSeenAt: "2026-01-28T12:00:00.000Z",
            keepaliveTtlSeconds: 1800,
            issueId: "i1",
            taskId: "t1",
            stepId: "s1",
            sandboxLastError: null,
          },
        ],
      },
    });

    await server.close();
  });

  it("POST /api/admin/sandboxes/control sends sandbox_control by runId", async () => {
    const server = createHttpServer();

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          sandboxInstanceName: null,
          agent: { proxyId: "proxy-1" },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { runId: "00000000-0000-0000-0000-000000000001", action: "inspect" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "sandbox_control",
        run_id: "r1",
        instance_name: "tuixiu-run-r1",
        action: "inspect",
      }),
    );

    await server.close();
  });

  it("POST /api/admin/sandboxes/control returns NOT_FOUND when proxyId specified but record missing", async () => {
    const server = createHttpServer();

    const prisma = {
      sandboxInstance: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          { proxyId: "proxy-2", instanceName: "tuixiu-run-r1", runId: null },
        ]),
      },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { instanceName: "tuixiu-run-r1", proxyId: "proxy-1", action: "stop" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "SandboxInstance 不存在" } });
    expect(sendToAgent).not.toHaveBeenCalled();
    expect(prisma.sandboxInstance.findMany).not.toHaveBeenCalled();

    await server.close();
  });

  it("POST /api/admin/sandboxes/control sends sandbox_control by instanceName when unique", async () => {
    const server = createHttpServer();

    const prisma = {
      sandboxInstance: {
        findMany: vi.fn().mockResolvedValue([
          { proxyId: "proxy-2", instanceName: "tuixiu-run-r1", runId: null },
        ]),
      },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { instanceName: "tuixiu-run-r1", action: "inspect" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-2",
      expect.objectContaining({
        type: "sandbox_control",
        instance_name: "tuixiu-run-r1",
        action: "inspect",
      }),
    );

    await server.close();
  });

  it("POST /api/admin/sandboxes/control supports prune_orphans by proxyId and returns requestId", async () => {
    const server = createHttpServer();

    const prisma = {
      sandboxInstance: {
        findMany: vi.fn().mockResolvedValue([
          { instanceName: "tuixiu-run-r1", runId: "r1" },
          { instanceName: "tuixiu-run-r2", runId: null },
        ]),
      },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { proxyId: "proxy-1", action: "prune_orphans" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ success: true, data: { ok: true, requestId: expect.any(String) } });
    const requestId = body.data.requestId;
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "sandbox_control",
        action: "prune_orphans",
        request_id: requestId,
        expected_instances: [
          { instance_name: "tuixiu-run-r1", run_id: "r1" },
          { instance_name: "tuixiu-run-r2", run_id: null },
        ],
      }),
    );

    await server.close();
  });

  it("POST /api/admin/sandboxes/control supports action=gc by proxyId and returns requestId", async () => {
    const server = createHttpServer();

    const prisma = {
      sandboxInstance: {
        findMany: vi.fn().mockResolvedValue([
          { instanceName: "tuixiu-run-r1", runId: "r1" },
          { instanceName: "tuixiu-run-r2", runId: null },
        ]),
      },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { proxyId: "proxy-1", action: "gc" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ success: true, data: { ok: true, requestId: expect.any(String) } });
    const requestId = body.data.requestId;
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "sandbox_control",
        action: "gc",
        request_id: requestId,
        expected_instances: [
          { instance_name: "tuixiu-run-r1", run_id: "r1" },
          { instance_name: "tuixiu-run-r2", run_id: null },
        ],
        dry_run: true,
      }),
    );

    await server.close();
  });

  it("POST /api/admin/sandboxes/control supports remove_workspace by runId and returns requestId", async () => {
    const server = createHttpServer();

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          sandboxInstanceName: null,
          agent: { proxyId: "proxy-1" },
        }),
      },
      event: { create: vi.fn().mockResolvedValue({ id: "e1" }) },
    } as any;

    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeSandboxRoutes({ prisma, auth, sendToAgent }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/sandboxes/control",
      payload: { runId: "00000000-0000-0000-0000-000000000001", action: "remove_workspace" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ success: true, data: { ok: true, requestId: expect.any(String) } });
    const requestId = body.data.requestId;
    expect(sendToAgent).toHaveBeenCalledWith(
      "proxy-1",
      expect.objectContaining({
        type: "sandbox_control",
        run_id: "r1",
        instance_name: "tuixiu-run-r1",
        action: "remove_workspace",
        request_id: requestId,
      }),
    );

    await server.close();
  });
});
