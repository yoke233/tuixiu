import { describe, expect, it, vi } from "vitest";

import { makeRunRoutes } from "../../src/routes/runs.js";
import { createHttpServer } from "../test-utils.js";

describe("Runs routes", () => {
  it("GET /api/runs/:id returns run", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue({ id: "r1" }) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { run: { id: "r1" } } });
    await server.close();
  });

  it("GET /api/runs/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { findUnique: vi.fn().mockResolvedValue(null) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({ method: "GET", url: "/api/runs/00000000-0000-0000-0000-000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Run 不存在" }
    });
    await server.close();
  });

  it("GET /api/runs/:id/events returns events", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { findMany: vi.fn().mockResolvedValue([{ id: "e1" }]) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "GET",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/events?limit=3"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { events: [{ id: "e1" }] } });
    expect(prisma.event.findMany).toHaveBeenCalledWith({
      where: { runId: "00000000-0000-0000-0000-000000000001" },
      orderBy: { timestamp: "desc" },
      take: 3
    });
    await server.close();
  });

  it("POST /api/runs/:id/cancel marks cancelled", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        update: vi.fn().mockResolvedValue({
          id: "r2",
          status: "cancelled",
          issueId: "i2",
          agentId: "a2",
          acpSessionId: "s2",
          workspacePath: "C:/repo/.worktrees/run-2",
          agent: { proxyId: "proxy-2" }
        })
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    const acp = { cancelSession: vi.fn().mockResolvedValue(undefined) } as any;

    await server.register(makeRunRoutes({ prisma, acp }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000002/cancel"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r2");
    expect(prisma.run.update).toHaveBeenCalled();
    const call = prisma.run.update.mock.calls[0][0];
    expect(call.where.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(call.data.status).toBe("cancelled");
    expect(call.data.completedAt).toBeInstanceOf(Date);
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    expect(acp.cancelSession).toHaveBeenCalledWith({
      proxyId: "proxy-2",
      runId: "00000000-0000-0000-0000-000000000002",
      cwd: "C:/repo/.worktrees/run-2",
      sessionId: "s2",
    });
    await server.close();
  });

  it("POST /api/runs/:id/complete marks completed", async () => {
    const server = createHttpServer();
    const prisma = {
      run: { update: vi.fn().mockResolvedValue({ id: "r2", status: "completed", issueId: "i2", agentId: "a2" }) },
      issue: { update: vi.fn().mockResolvedValue({}) },
      agent: { update: vi.fn().mockResolvedValue({}) }
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000002/complete"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r2");
    expect(prisma.run.update).toHaveBeenCalled();
    const call = prisma.run.update.mock.calls[0][0];
    expect(call.where.id).toBe("00000000-0000-0000-0000-000000000002");
    expect(call.data.status).toBe("completed");
    expect(call.data.completedAt).toBeInstanceOf(Date);
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/prompt persists user message and forwards to agent", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          workspacePath: "C:/repo/.worktrees/run-1",
          acpSessionId: null,
          agent: { proxyId: "proxy-1" },
          issue: { title: "t1" },
          artifacts: []
        })
      },
      event: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn().mockResolvedValue([]) }
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }) } as any;
    await server.register(makeRunRoutes({ prisma, acp }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/prompt",
      payload: { text: "hello" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { ok: true } });

    expect(prisma.event.create).toHaveBeenCalled();
    expect(acp.promptRun).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyId: "proxy-1",
        runId: "00000000-0000-0000-0000-000000000001",
        cwd: "C:/repo/.worktrees/run-1",
        sessionId: null,
        prompt: "hello",
        context: expect.any(String),
      }),
    );
    await server.close();
  });

  it("POST /api/runs/:id/prompt does not persist user message when ACP tunnel missing", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          workspacePath: "C:/repo/.worktrees/run-1",
          acpSessionId: null,
          agent: { proxyId: "proxy-1" },
          issue: { title: "t1" },
          artifacts: [],
        }),
      },
      event: { create: vi.fn(), findMany: vi.fn() },
    } as any;

    await server.register(makeRunRoutes({ prisma }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/prompt",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NO_AGENT_GATEWAY", message: "ACP 隧道未配置" },
    });

    expect(prisma.event.create).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/prompt does not persist user message when sending fails", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          workspacePath: "C:/repo/.worktrees/run-1",
          acpSessionId: null,
          agent: { proxyId: "proxy-1" },
          issue: { title: "t1" },
          artifacts: [],
        }),
      },
      event: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const acp = { promptRun: vi.fn().mockRejectedValue(new Error("boom")) } as any;
    await server.register(makeRunRoutes({ prisma, acp }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/prompt",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("AGENT_SEND_FAILED");
    expect(prisma.event.create).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/prompt returns ok when event persistence fails after sending", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          workspacePath: "C:/repo/.worktrees/run-1",
          acpSessionId: null,
          agent: { proxyId: "proxy-1" },
          issue: { title: "t1" },
          artifacts: [],
        }),
      },
      event: { create: vi.fn().mockRejectedValue(new Error("db down")), findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }) } as any;
    await server.register(makeRunRoutes({ prisma, acp }), { prefix: "/api/runs" });

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/prompt",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { ok: true, warning: { code: "EVENT_PERSIST_FAILED", message: "消息已发送，但写入事件失败" } },
    });

    expect(acp.promptRun).toHaveBeenCalled();
    expect(prisma.event.create).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/pause forwards session_cancel to agent", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          acpSessionId: "s1",
          workspacePath: "C:/repo/.worktrees/run-1",
          agent: { proxyId: "proxy-1" },
        })
      }
    } as any;

    const acp = { cancelSession: vi.fn().mockResolvedValue(undefined) } as any;
    await server.register(makeRunRoutes({ prisma, acp }), { prefix: "/api/runs" });

    const runId = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({
      method: "POST",
      url: `/api/runs/${runId}/pause`
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


  it("POST /api/runs/:id/create-pr pushes branch and creates PR artifact", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "completed",
          branchName: "run/r1",
          workspacePath: "D:\\repo\\.worktrees\\run-r1",
          issue: {
            id: "i1",
            title: "t1",
            description: "d1",
            project: {
              repoUrl: "https://gitlab.example.com/group/repo.git",
              scmType: "gitlab",
              defaultBranch: "main",
              gitlabProjectId: 123,
              gitlabAccessToken: "tok"
            }
          },
          artifacts: []
        }),
        update: vi.fn().mockResolvedValue({})
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "pr-1", type: "pr" }) }
    } as any;

    const gitPush = vi.fn().mockResolvedValue(undefined);
    const createMergeRequest = vi.fn().mockResolvedValue({
      id: 9,
      iid: 7,
      title: "t1",
      state: "opened",
      web_url: "https://gitlab.example.com/group/repo/-/merge_requests/7",
      source_branch: "run/r1",
      target_branch: "main"
    });

    await server.register(
      makeRunRoutes({
        prisma,
        gitPush,
        gitlab: {
          inferBaseUrl: () => "https://gitlab.example.com",
          createMergeRequest,
          mergeMergeRequest: vi.fn(),
          getMergeRequest: vi.fn()
        }
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/create-pr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(gitPush).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "D:\\repo\\.worktrees\\run-r1", branch: "run/r1" }),
    );
    expect(createMergeRequest).toHaveBeenCalled();
    expect(prisma.artifact.create).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: { status: "waiting_ci" } })
    );
    await server.close();
  });

  it("POST /api/runs/:id/merge-pr requires approval (creates approval request)", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: {
            id: "i1",
            project: {
              repoUrl: "https://gitlab.example.com/group/repo.git",
              scmType: "gitlab",
            }
          },
          artifacts: [{ id: "pr-1", type: "pr", content: { iid: 7, webUrl: "https://gitlab.example.com/group/repo/-/merge_requests/7" } }]
        }),
      },
      artifact: {
        create: vi.fn().mockResolvedValue({
          id: "ap-1",
          runId: "r1",
          type: "report",
          content: { kind: "approval_request", action: "merge_pr", status: "pending" },
          createdAt: "2026-01-25T00:00:00.000Z"
        })
      }
    } as any;

    await server.register(
      makeRunRoutes({
        prisma
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/merge-pr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("APPROVAL_REQUIRED");
    expect(prisma.artifact.create).toHaveBeenCalled();
    const call = prisma.artifact.create.mock.calls[0][0];
    expect(call.data.type).toBe("report");
    expect(call.data.content.action).toBe("merge_pr");
    expect(call.data.content.status).toBe("pending");
    expect(call.data.content.requestedBy).toBe("api_merge_pr");
    await server.close();
  });

  it("POST /api/runs/:id/create-pr supports GitHub (creates PR artifact)", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          status: "completed",
          branchName: "run/r1",
          workspacePath: "D:\\repo\\.worktrees\\run-r1",
          issue: {
            id: "i1",
            title: "t1",
            description: "d1",
            project: {
              repoUrl: "https://github.com/octo-org/octo-repo.git",
              scmType: "github",
              defaultBranch: "main",
              githubAccessToken: "ghp_xxx"
            }
          },
          artifacts: []
        }),
        update: vi.fn().mockResolvedValue({})
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "pr-1", type: "pr" }) }
    } as any;

    const gitPush = vi.fn().mockResolvedValue(undefined);
    const createPullRequest = vi.fn().mockResolvedValue({
      id: 99,
      number: 12,
      title: "t1",
      state: "open",
      html_url: "https://github.com/octo-org/octo-repo/pull/12",
      head: { ref: "run/r1" },
      base: { ref: "main" }
    });

    await server.register(
      makeRunRoutes({
        prisma,
        gitPush,
        github: {
          parseRepo: () => ({
            host: "github.com",
            owner: "octo-org",
            repo: "octo-repo",
            webBaseUrl: "https://github.com/octo-org/octo-repo",
            apiBaseUrl: "https://api.github.com"
          }),
          createPullRequest,
          mergePullRequest: vi.fn(),
          getPullRequest: vi.fn()
        }
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/create-pr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(gitPush).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "D:\\repo\\.worktrees\\run-r1", branch: "run/r1" }),
    );
    expect(createPullRequest).toHaveBeenCalled();
    expect(prisma.artifact.create).toHaveBeenCalled();
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: { status: "waiting_ci" } })
    );
    await server.close();
  });

  it("POST /api/runs/:id/merge-pr supports GitHub (requires approval)", async () => {
    const server = createHttpServer();
    const prisma = {
      event: { create: vi.fn().mockResolvedValue({}) },
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: {
            id: "i1",
            project: {
              repoUrl: "https://github.com/octo-org/octo-repo.git",
              scmType: "github",
              githubAccessToken: "ghp_xxx"
            }
          },
          artifacts: [{ id: "pr-1", type: "pr", content: { number: 12, webUrl: "https://github.com/octo-org/octo-repo/pull/12" } }]
        }),
      },
      artifact: {
        create: vi.fn().mockResolvedValue({
          id: "ap-1",
          runId: "r1",
          type: "report",
          content: { kind: "approval_request", action: "merge_pr", status: "pending" },
          createdAt: "2026-01-25T00:00:00.000Z"
        })
      }
    } as any;

    await server.register(
      makeRunRoutes({
        prisma
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/merge-pr",
      payload: {}
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("APPROVAL_REQUIRED");
    expect(prisma.artifact.create).toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/runs/:id/sync-pr supports GitHub (syncs mergeable state)", async () => {
    const server = createHttpServer();
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          issueId: "i1",
          issue: {
            id: "i1",
            project: {
              repoUrl: "https://github.com/octo-org/octo-repo.git",
              scmType: "github",
              githubAccessToken: "ghp_xxx"
            }
          },
          artifacts: [{ id: "pr-1", type: "pr", content: { number: 12 } }]
        }),
        update: vi.fn().mockResolvedValue({})
      },
      issue: { update: vi.fn().mockResolvedValue({}) },
      artifact: { update: vi.fn().mockResolvedValue({ id: "pr-1", type: "pr" }) }
    } as any;

    const getPullRequest = vi.fn().mockResolvedValue({
      id: 99,
      number: 12,
      title: "t1",
      state: "open",
      html_url: "https://github.com/octo-org/octo-repo/pull/12",
      head: { ref: "run/r1" },
      base: { ref: "main" },
      merged_at: null,
      mergeable: false,
      mergeable_state: "dirty"
    });

    await server.register(
      makeRunRoutes({
        prisma,
        github: {
          parseRepo: () => ({
            host: "github.com",
            owner: "octo-org",
            repo: "octo-repo",
            webBaseUrl: "https://github.com/octo-org/octo-repo",
            apiBaseUrl: "https://api.github.com"
          }),
          createPullRequest: vi.fn(),
          mergePullRequest: vi.fn(),
          getPullRequest
        }
      }),
      { prefix: "/api/runs" }
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/runs/00000000-0000-0000-0000-000000000001/sync-pr",
      payload: {}
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    expect(getPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pullNumber: 12 })
    );

    expect(prisma.artifact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pr-1" },
        data: expect.objectContaining({
          content: expect.objectContaining({
            mergeable: false,
            mergeable_state: "dirty"
          })
        })
      })
    );

    expect(prisma.issue.update).not.toHaveBeenCalled();
    await server.close();
  });
});
