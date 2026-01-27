import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/taskEngine.js", () => {
  class TaskEngineError extends Error {
    code: string;
    details?: string;

    constructor(code: string, message: string, details?: string) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }

  return {
    TaskEngineError,
    createTaskFromTemplate: vi.fn(),
    startStep: vi.fn(),
  };
});

vi.mock("../../src/services/executionDispatch.js", () => ({
  dispatchExecutionForRun: vi.fn(),
}));

import { makeAcpSessionRoutes } from "../../src/routes/acpSessions.js";
import { dispatchExecutionForRun } from "../../src/services/executionDispatch.js";
import { createTaskFromTemplate, startStep } from "../../src/services/taskEngine.js";
import { createHttpServer } from "../test-utils.js";

describe("ACP session admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/admin/acp-sessions returns sessions", async () => {
    const server = createHttpServer();
    const projectId = "00000000-0000-0000-0000-000000000001";
    const issueId = "00000000-0000-0000-0000-000000000002";
    const runId = "00000000-0000-0000-0000-000000000003";
    const agentId = "00000000-0000-0000-0000-000000000004";
    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: runId,
            issueId,
            status: "running",
            acpSessionId: "s1",
            startedAt: new Date("2026-01-25T00:00:00.000Z"),
            completedAt: null,
            issue: { id: issueId, title: "Issue 1", projectId },
            agent: { id: agentId, name: "proxy", proxyId: "proxy-1", status: "online" },
          },
        ]),
      },
    } as any;
    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    await server.register(makeAcpSessionRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "GET",
      url: `/api/admin/acp-sessions?projectId=${projectId}&limit=10`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: {
        sessions: [
          {
            runId,
            issueId,
            issueTitle: "Issue 1",
            projectId,
            runStatus: "running",
            sessionId: "s1",
            sessionState: {
              sessionId: "s1",
              activity: "unknown",
              inFlight: 0,
              updatedAt: "2026-01-25T00:00:00.000Z",
              currentModeId: null,
              currentModelId: null,
              lastStopReason: null,
              note: "no_state",
            },
            startedAt: "2026-01-25T00:00:00.000Z",
            completedAt: null,
            agent: { id: agentId, name: "proxy", proxyId: "proxy-1", status: "online" },
          },
        ],
      },
    });

    await server.close();
  });

  it("GET /api/admin/acp-sessions filters archived issues", async () => {
    const server = createHttpServer();
    const projectId = "00000000-0000-0000-0000-000000000010";
    const prisma = {
      run: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;
    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    await server.register(makeAcpSessionRoutes({ prisma, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "GET",
      url: `/api/admin/acp-sessions?projectId=${projectId}&limit=10`,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          executorType: "agent",
          acpSessionId: { not: null },
          issue: { projectId, archivedAt: null },
        },
      }),
    );

    await server.close();
  });

  it("POST /api/admin/acp-sessions/start creates hidden issue and dispatches run", async () => {
    const server = createHttpServer();
    const projectId = "00000000-0000-0000-0000-000000000001";
    const issueId = "00000000-0000-0000-0000-000000000002";
    const taskId = "00000000-0000-0000-0000-000000000003";
    const stepId = "00000000-0000-0000-0000-000000000004";
    const runId = "00000000-0000-0000-0000-000000000005";

    const prisma = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: projectId }),
      },
      issue: {
        create: vi.fn().mockResolvedValue({ id: issueId }),
      },
      task: {
        update: vi.fn().mockResolvedValue({ id: taskId }),
      },
    } as any;

    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    const createWorkspace = vi.fn().mockResolvedValue({ workspacePath: "D:/ws", branchName: "b1", baseBranch: "main", mode: "worktree" });
    const acp = { promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }) } as any;
    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    (createTaskFromTemplate as any).mockResolvedValue({ id: taskId, currentStepId: stepId });
    (startStep as any).mockResolvedValue({ task: { id: taskId }, step: { id: stepId }, run: { id: runId } });
    (dispatchExecutionForRun as any).mockResolvedValue({ success: true, data: { ok: true } });

    await server.register(makeAcpSessionRoutes({ prisma, sendToAgent, acp, createWorkspace, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/acp-sessions/start",
      payload: { projectId, goal: "test goal", worktreeName: "test-wt" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { issueId, taskId, stepId, runId },
    });

    expect(createTaskFromTemplate).toHaveBeenCalledWith({ prisma }, issueId, { templateKey: "quick.admin.session" });
    expect(startStep).toHaveBeenCalledWith({ prisma }, stepId, { roleKey: undefined });
    expect(dispatchExecutionForRun).toHaveBeenCalledWith(
      expect.objectContaining({ prisma, sendToAgent, acp, createWorkspace }),
      runId,
    );

    await server.close();
  });

  it("POST /api/admin/acp-sessions/cancel calls acpTunnel.cancelSession", async () => {
    const server = createHttpServer();
    const runId = "00000000-0000-0000-0000-000000000003";
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: runId,
          workspacePath: "C:/repo/.worktrees/run-1",
          agent: { proxyId: "proxy-1" },
        }),
      },
    } as any;
    const sendToAgent = vi.fn().mockResolvedValue(undefined);
    const acp = {
      cancelSession: vi.fn().mockResolvedValue(undefined),
    } as any;
    const auth = {
      requireRoles: vi.fn().mockReturnValue(async () => {}),
    } as any;

    await server.register(makeAcpSessionRoutes({ prisma, sendToAgent, acp, auth }), { prefix: "/api/admin" });

    const res = await server.inject({
      method: "POST",
      url: "/api/admin/acp-sessions/cancel",
      payload: { runId, sessionId: "s1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });
    expect(acp.cancelSession).toHaveBeenCalledWith({
      proxyId: "proxy-1",
      runId,
      cwd: "C:/repo/.worktrees/run-1",
      sessionId: "s1",
    });

    await server.close();
  });
});
