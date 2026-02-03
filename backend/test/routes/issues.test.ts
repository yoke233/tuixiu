import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { makeIssueRoutes } from "../../src/routes/issues.js";
import { createHttpServer } from "../test-utils.js";

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((b: any) => (b && b.type === "text" ? String(b.text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return String(prompt ?? "");
}

const defaultRoleEnv = "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=role-gh\n";

function makeRoleTemplate(overrides?: Partial<any>) {
  return {
    id: "role-1",
    key: "dev",
    displayName: "Dev",
    envText: defaultRoleEnv,
    initTimeoutSeconds: 120,
    ...overrides,
  };
}

describe("Issues routes", () => {
  const originalEnv = {
    WORKTREE_NAME_LLM: process.env.WORKTREE_NAME_LLM,
    WORKTREE_NAME_LLM_API_KEY: process.env.WORKTREE_NAME_LLM_API_KEY,
    WORKTREE_NAME_LLM_MODEL: process.env.WORKTREE_NAME_LLM_MODEL,
    WORKTREE_NAME_LLM_BASE_URL: process.env.WORKTREE_NAME_LLM_BASE_URL,
    WORKTREE_NAME_LLM_TIMEOUT_MS: process.env.WORKTREE_NAME_LLM_TIMEOUT_MS,
  };

  beforeEach(() => {
    delete process.env.WORKTREE_NAME_LLM;
    delete process.env.WORKTREE_NAME_LLM_API_KEY;
    delete process.env.WORKTREE_NAME_LLM_MODEL;
    delete process.env.WORKTREE_NAME_LLM_BASE_URL;
    delete process.env.WORKTREE_NAME_LLM_TIMEOUT_MS;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === "string") process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("GET /api/issues without status uses empty where", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({ method: "GET", url: "/api/issues?limit=1&offset=0" });
    expect(res.statusCode).toBe(200);
    expect(prisma.issue.count).toHaveBeenCalledWith({ where: {} });
    await server.close();
  });

  it("GET /api/issues returns list with total", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(12),
        findMany: vi.fn().mockResolvedValue([{ id: "i1" }]),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues?limit=2&offset=1&status=pending",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { issues: [{ id: "i1" }], total: 12, limit: 2, offset: 1 },
    });
    await server.close();
  });

  it("GET /api/issues supports statuses filter (comma separated)", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues?limit=10&offset=0&statuses=done,failed",
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.issue.count).toHaveBeenCalledWith({
      where: { status: { in: ["done", "failed"] } },
    });
    expect(prisma.issue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["done", "failed"] } } }),
    );

    await server.close();
  });

  it("GET /api/issues supports archived filter", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues?limit=10&offset=0&archived=true",
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.issue.count).toHaveBeenCalledWith({ where: { archivedAt: { not: null } } });

    await server.close();
  });

  it("GET /api/issues/:id returns NOT_FOUND when missing", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Issue 不存在" },
    });
    await server.close();
  });

  it("GET /api/issues/:id returns issue when found", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue({ id: "i1" }) },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "GET",
      url: "/api/issues/00000000-0000-0000-0000-000000000001",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1" } } });
    await server.close();
  });

  it("POST /api/issues returns NO_PROJECT when there is no project", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "NO_PROJECT", message: "请先创建 Project" },
    });
    await server.close();
  });

  it("POST /api/issues returns issue only when no available agents", async () => {
    const server = createHttpServer();
    const prisma = {
      project: { findFirst: vi.fn().mockResolvedValue({ id: "p1" }) },
      issue: { create: vi.fn().mockResolvedValue({ id: "i1", title: "t1" }) },
    } as any;

    const sendToAgent = vi.fn();
    await server.register(makeIssueRoutes({ prisma, sendToAgent }), { prefix: "/api/issues" });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues",
      payload: { title: "t1", acceptanceCriteria: ["a"], constraints: ["c"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", title: "t1" } } });
    expect(sendToAgent).not.toHaveBeenCalled();
    await server.close();
  });

  it("POST /api/issues/:id/start schedules run and calls acp.promptRun", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/t1-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-t1-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: "d1",
          status: "pending",
          acceptanceCriteria: ["a1"],
          constraints: ["c1"],
          testRequirements: null,
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.run.id).toBe("r1");

    expect(acp.promptRun).toHaveBeenCalledTimes(1);
    const promptCall = acp.promptRun.mock.calls[0][0];
    expect(promptCall.proxyId).toBe("proxy-1");
    expect(promptCall.runId).toBe("r1");
    expect(promptCall.sessionId).toBeNull();
    expect(promptCall.cwd).toBe("/workspace");
    const promptText = extractPromptText(promptCall.prompt);
    expect(promptText).toContain("任务标题: t1");
    expect(promptText).toContain("- workspace:");
    expect(promptText).toContain("run/t1-r1");
    expect(promptText).toContain("任务描述:");
    expect(promptText).toContain("验收标准:");
    expect(promptText).toContain("约束条件:");

    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "t1-r1",
    });
    await server.close();
  });

  it("POST /api/issues/:id/start uses GitHub issue number when worktreeName missing", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/gh-456-fix-login-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-gh-456-fix-login-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "Fix login",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          externalProvider: "github",
          externalNumber: 456,
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" },
    });
    expect(res.statusCode).toBe(200);
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "gh-456-fix-login-r1",
    });
    await server.close();
  });

  it("POST /api/issues/:id/start drops non-ascii in auto worktreeName", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/gh-456-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-gh-456-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "修复登录",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          externalProvider: "github",
          externalNumber: 456,
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" },
    });
    expect(res.statusCode).toBe(200);
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "gh-456-r1",
    });
    await server.close();
  });

  it("POST /api/issues/:id/start uses LLM slug when enabled", async () => {
    process.env.WORKTREE_NAME_LLM = "1";
    process.env.WORKTREE_NAME_LLM_API_KEY = "sk-test-123456";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "worktree-name-fix" } }],
      }),
    });

    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;

    try {
      const server = createHttpServer();
      const createWorkspace = vi.fn().mockResolvedValue({
        repoRoot: "D:\\xyad\\tuixiu",
        branchName: "run/gh-456-worktree-name-fix-r1",
        workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-gh-456-worktree-name-fix-r1",
      });
      const prisma = {
        issue: {
          findUnique: vi.fn().mockResolvedValue({
            id: "i1",
            projectId: "p1",
            title: "自动生成的worktreename 把中文也填进去了",
            description: null,
            status: "pending",
            acceptanceCriteria: [],
            constraints: [],
            testRequirements: null,
            externalProvider: "github",
            externalNumber: 456,
            runs: [],
            project: {
              id: "p1",
              defaultBranch: "main",
              defaultRoleKey: "dev",
              repoUrl: "https://example.com/repo.git",
              scmType: "github",
              runGitCredentialId: "c-run",
            },
          }),
          update: vi.fn().mockResolvedValue({ id: "i1" }),
        },
        roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
        gitCredential: {
          findUnique: vi.fn().mockResolvedValue({
            id: "c-run",
            projectId: "p1",
            gitAuthMode: "https_pat",
            githubAccessToken: "gh-run",
          }),
        },
        agent: {
          findUnique: vi.fn().mockResolvedValue({
            id: "a1",
            proxyId: "proxy-1",
            status: "online",
            currentLoad: 0,
            maxConcurrentRuns: 1,
          }),
          update: vi.fn().mockResolvedValue({ id: "a1" }),
        },
        run: {
          create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
          update: vi.fn().mockResolvedValue({ id: "r1" }),
        },
        artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
      } as any;

      const acp = {
        promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
      } as any;
      await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
        prefix: "/api/issues",
      });

      const res = await server.inject({
        method: "POST",
        url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
        payload: { agentId: "00000000-0000-0000-0000-000000000010" },
      });
      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(createWorkspace).toHaveBeenCalledWith({
        runId: "r1",
        baseBranch: "main",
        name: "gh-456-worktree-name-fix-r1",
      });
      await server.close();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it("POST /api/issues/:id/start forwards user worktreeName when provided", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/my-feature",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-my-feature",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010", worktreeName: "my-feature" },
    });
    expect(res.statusCode).toBe(200);
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "my-feature",
    });
    await server.close();
  });

  it("POST /api/issues/:id/start includes testRequirements when present", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/t1-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-t1-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: "需要加单测",
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" },
    });
    expect(res.statusCode).toBe(200);

    const call = acp.promptRun.mock.calls[0][0];
    const promptText = extractPromptText(call.prompt);
    expect(promptText).toContain("测试要求:");
    expect(promptText).toContain("需要加单测");
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "t1-r1",
    });

    await server.close();
  });

  it("POST /api/issues/:id/start sends init when roleKey provided", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/t1-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-t1-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: "d1",
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          runs: [],
          project: {
            id: "p1",
            name: "Demo",
            repoUrl: "https://github.com/o/r",
            scmType: "github",
            defaultBranch: "main",
            runGitCredentialId: "c-run",
            githubAccessToken: "ghp_xxx",
            defaultRoleKey: "dev",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "role-1",
          key: "backend-dev",
          displayName: "后端开发",
          promptTemplate: "你是 {{role.name}}，请优先写单测。",
          initScript: "echo init",
          initTimeoutSeconds: 120,
          envText: "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=ghp_role_xxx",
        }),
      },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
    } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010", roleKey: "backend-dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.roleTemplate.findFirst).toHaveBeenCalled();

    const call = acp.promptRun.mock.calls[0][0];
    const promptText = extractPromptText(call.prompt);
    expect(promptText).toContain("角色指令:");
    expect(promptText).toContain("后端开发");
    expect(call.init).toEqual(
      expect.objectContaining({
        script: expect.stringContaining("echo init"),
        timeout_seconds: 120,
        env: expect.objectContaining({
          GH_TOKEN: "gh-run",
          TUIXIU_ROLE_KEY: "backend-dev",
          TUIXIU_RUN_ID: "r1",
        }),
      }),
    );
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "t1-r1",
    });

    await server.close();
  });

  it("POST /api/issues/:id/start marks run failed when acp.promptRun throws", async () => {
    const server = createHttpServer();
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\xyad\\tuixiu",
      branchName: "run/t1-r1",
      workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-t1-r1",
    });
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: null,
          status: "pending",
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          runs: [],
          project: {
            id: "p1",
            defaultBranch: "main",
            defaultRoleKey: "dev",
            repoUrl: "https://example.com/repo.git",
            scmType: "github",
            runGitCredentialId: "c-run",
          },
        }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
      agent: {
        findUnique: vi.fn().mockResolvedValue({
          id: "a1",
          proxyId: "proxy-1",
          status: "online",
          currentLoad: 0,
          maxConcurrentRuns: 1,
        }),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: "i1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
    } as any;

    const acp = { promptRun: vi.fn().mockRejectedValue(new Error("boom")) } as any;
    await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
      payload: { agentId: "00000000-0000-0000-0000-000000000010" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("AGENT_SEND_FAILED");
    expect(prisma.run.update).toHaveBeenCalled();
    expect(prisma.issue.update).toHaveBeenCalled();
    expect(prisma.agent.update).toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "t1-r1",
    });
    await server.close();
  });

  it("PATCH /api/issues/:id updates status when not running", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "pending" }),
        update: vi.fn().mockResolvedValue({ id: "i1", status: "done" }),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const id = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({
      method: "PATCH",
      url: `/api/issues/${id}`,
      payload: { status: "done" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { issue: { id: "i1", status: "done" } } });
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id }, data: { status: "done" } });

    await server.close();
  });

  it("POST /api/issues/:id/start comments on GitHub issue when GitHub token exists", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi
        .fn()
        .mockResolvedValue({ id: 1, html_url: "https://github.com/o/r/issues/123#issuecomment-1" }),
    });
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;

    try {
      const server = createHttpServer();
      const createWorkspace = vi.fn().mockResolvedValue({
        repoRoot: "D:\\xyad\\tuixiu",
        branchName: "run/gh-123-t1-r1",
        workspacePath: "D:\\xyad\\tuixiu\\.worktrees\\run-gh-123-t1-r1",
      });
      const prisma = {
        issue: {
          findUnique: vi.fn().mockResolvedValue({
            id: "i1",
            projectId: "p1",
            title: "t1",
            description: null,
            status: "pending",
            acceptanceCriteria: [],
            constraints: [],
            testRequirements: null,
            externalProvider: "github",
            externalNumber: 123,
            runs: [],
            project: {
              id: "p1",
              defaultBranch: "main",
              repoUrl: "https://github.com/o/r",
              scmType: "github",
              runGitCredentialId: "c-run",
              githubAccessToken: "ghp_test",
              defaultRoleKey: "dev",
            },
          }),
          update: vi.fn().mockResolvedValue({ id: "i1" }),
        },
        agent: {
          findUnique: vi.fn().mockResolvedValue({
            id: "a1",
            proxyId: "proxy-1",
            name: "codex-local-1",
            status: "online",
            currentLoad: 0,
            maxConcurrentRuns: 1,
          }),
          update: vi.fn().mockResolvedValue({ id: "a1" }),
        },
        roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
        gitCredential: {
          findUnique: vi.fn().mockResolvedValue({
            id: "c-run",
            projectId: "p1",
            gitAuthMode: "https_pat",
            githubAccessToken: "gh-run",
          }),
        },
        run: {
          create: vi.fn().mockResolvedValue({ id: "r1", acpSessionId: null }),
          update: vi.fn().mockResolvedValue({ id: "r1" }),
        },
        artifact: { create: vi.fn().mockResolvedValue({ id: "art-1" }) },
      } as any;

      const acp = {
        promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }),
      } as any;
      await server.register(makeIssueRoutes({ prisma, acp, createWorkspace }), {
        prefix: "/api/issues",
      });

      const res = await server.inject({
        method: "POST",
        url: "/api/issues/00000000-0000-0000-0000-000000000001/start",
        payload: { agentId: "00000000-0000-0000-0000-000000000010" },
      });

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [url1, init1] = fetchMock.mock.calls[0];
      expect(String(url1)).toContain("https://api.github.com/repos/o/r/issues/123/comments");
      expect(init1.method).toBe("POST");
      const body1 = JSON.parse(String(init1.body));
      expect(String(body1.body)).toContain("已分配执行者");
      expect(String(body1.body)).toContain("codex-local-1");
      expect(String(body1.body)).toContain("`r1`");

      const [url2, init2] = fetchMock.mock.calls[1];
      expect(String(url2)).toContain("https://api.github.com/repos/o/r/issues/123/comments");
      const body2 = JSON.parse(String(init2.body));
      expect(String(body2.body)).toContain("开始执行");
      expect(String(body2.body)).toContain("`run/gh-123-t1-r1`");

      await server.close();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });

  it("PATCH /api/issues/:id archives completed issue", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "done", archivedAt: null }),
        update: vi
          .fn()
          .mockResolvedValue({ id: "i1", status: "done", archivedAt: "2026-01-25T00:00:00.000Z" }),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const id = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({
      method: "PATCH",
      url: `/api/issues/${id}`,
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true,
      data: { issue: { id: "i1", status: "done", archivedAt: "2026-01-25T00:00:00.000Z" } },
    });
    expect(prisma.issue.update).toHaveBeenCalledWith({
      where: { id },
      data: { archivedAt: expect.any(Date) },
    });

    await server.close();
  });

  it("PATCH /api/issues/:id archives issue and cancels acp session", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: "i1", status: "done", archivedAt: null, labels: [] }),
        update: vi
          .fn()
          .mockResolvedValue({ id: "i1", status: "done", archivedAt: "2026-01-25T00:00:00.000Z" }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "r1",
            acpSessionId: "s1",
            workspacePath: "C:/repo/.worktrees/run-1",
            agent: { proxyId: "proxy-1" },
          },
        ]),
      },
    } as any;
    const acp = { cancelSession: vi.fn().mockResolvedValue(undefined) } as any;

    await server.register(makeIssueRoutes({ prisma, acp }), { prefix: "/api/issues" });

    const id = "00000000-0000-0000-0000-000000000001";
    const res = await server.inject({
      method: "PATCH",
      url: `/api/issues/${id}`,
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.run.findMany).toHaveBeenCalledWith({
      where: { issueId: id, acpSessionId: { not: null } },
      select: {
        id: true,
        acpSessionId: true,
        agent: { select: { proxyId: true } },
      },
    });
    expect(acp.cancelSession).toHaveBeenCalledWith({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "/workspace",
      sessionId: "s1",
    });

    await server.close();
  });

  it("PATCH /api/issues/:id archives running session issue", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi
          .fn()
          .mockResolvedValue({
            id: "i1",
            status: "running",
            archivedAt: null,
            labels: ["_session"],
          }),
        update: vi
          .fn()
          .mockResolvedValue({
            id: "i1",
            status: "running",
            archivedAt: "2026-01-25T00:00:00.000Z",
          }),
      },
      run: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "r1",
            acpSessionId: "s1",
            workspacePath: "C:/repo/.worktrees/run-1",
            agent: { proxyId: "proxy-1" },
          },
        ]),
      },
    } as any;
    const acp = { cancelSession: vi.fn().mockResolvedValue(undefined) } as any;

    await server.register(makeIssueRoutes({ prisma, acp }), { prefix: "/api/issues" });

    const id = "00000000-0000-0000-0000-000000000010";
    const res = await server.inject({
      method: "PATCH",
      url: `/api/issues/${id}`,
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(200);
    expect(acp.cancelSession).toHaveBeenCalledWith({
      proxyId: "proxy-1",
      runId: "r1",
      cwd: "/workspace",
      sessionId: "s1",
    });

    await server.close();
  });

  it("PATCH /api/issues/:id returns ISSUE_NOT_COMPLETED when archiving pending issue", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "pending", archivedAt: null }),
        update: vi.fn(),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/issues/00000000-0000-0000-0000-000000000001",
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "ISSUE_NOT_COMPLETED", message: "仅已完成/失败/取消的 Issue 才能归档" },
    });
    expect(prisma.issue.update).not.toHaveBeenCalled();

    await server.close();
  });

  it("PATCH /api/issues/:id returns ISSUE_RUNNING when issue is running", async () => {
    const server = createHttpServer();
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({ id: "i1", status: "running" }),
        update: vi.fn(),
      },
    } as any;

    await server.register(makeIssueRoutes({ prisma, sendToAgent: vi.fn() }), {
      prefix: "/api/issues",
    });

    const res = await server.inject({
      method: "PATCH",
      url: "/api/issues/00000000-0000-0000-0000-000000000001",
      payload: { status: "done" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: { code: "ISSUE_RUNNING", message: "Issue 正在运行中，请先完成/取消 Run" },
    });
    expect(prisma.issue.update).not.toHaveBeenCalled();

    await server.close();
  });
});
