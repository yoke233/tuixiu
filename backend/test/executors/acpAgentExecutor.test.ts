import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/gitWorkspace.js", () => ({ suggestRunKeyWithLlm: vi.fn() }));
vi.mock("../../src/modules/acp/contextPack.js", () => ({ buildContextPackPrompt: vi.fn() }));
vi.mock("../../src/modules/templates/textTemplates.js", () => ({
  renderTextTemplateFromDb: vi.fn(),
}));

const { startAcpAgentExecution } = await import("../../src/executors/acpAgentExecutor.js");
const { suggestRunKeyWithLlm } = await import("../../src/utils/gitWorkspace.js");
const { buildContextPackPrompt } = await import("../../src/modules/acp/contextPack.js");
const { renderTextTemplateFromDb } = await import("../../src/modules/templates/textTemplates.js");

function makeAgent(overrides?: Partial<any>) {
  return {
    id: "a1",
    status: "online",
    currentLoad: 0,
    maxConcurrentRuns: 1,
    proxyId: "proxy-1",
    ...overrides,
  };
}

const defaultRoleEnv = "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=role-gh\n";

function makeRoleTemplate(overrides?: Partial<any>) {
  return {
    key: "dev",
    displayName: "Dev",
    envText: defaultRoleEnv,
    ...overrides,
  };
}

function makeRun(opts?: {
  kind?: string;
  stepParams?: any;
  stepRoleKey?: string | null;
  stepKey?: string;
  projectNoticeTemplate?: any;
}) {
  const step = {
    id: "s1",
    kind: opts?.kind ?? "test.run",
    key: opts?.stepKey ?? "step-1",
    roleKey: opts?.stepRoleKey ?? null,
    params: opts?.stepParams ?? { command: "pnpm test" },
  };

  const project = {
    id: "p1",
    name: "P1",
    repoUrl: "https://example.com/repo.git",
    scmType: "github",
    defaultBranch: "main",
    defaultRoleKey: "dev",
    githubAccessToken: "proj-gh",
    gitlabAccessToken: "proj-gl",
    agentWorkspaceNoticeTemplate: opts?.projectNoticeTemplate,
  };

  const issue = {
    id: "i1",
    projectId: "p1",
    title: "Issue title",
    description: "Issue desc",
    status: "pending",
    testRequirements: "pnpm -r test",
    acceptanceCriteria: ["a1"],
    constraints: ["c1"],
    assignedAgentId: null,
    externalProvider: "github",
    externalNumber: 123,
    project,
  };

  const task = {
    id: "t1",
    issue,
    workspaceType: "worktree",
    workspacePath: "C:/ws",
    branchName: "run-branch",
    baseBranch: "main",
  };

  return {
    id: "r1",
    acpSessionId: null,
    step,
    task,
  };
}

describe("acpAgentExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    (buildContextPackPrompt as any).mockResolvedValue("CTX_PACK");
    (renderTextTemplateFromDb as any).mockImplementation(async (_deps: any, input: any) => {
      const key = String(input?.key ?? "");
      const vars = input?.vars ?? {};
      return `KEY=${key};VARS=${JSON.stringify(vars)}`;
    });
  });

  it("throws when acpTunnel missing", async () => {
    const prisma = {} as any;
    await expect(startAcpAgentExecution({ prisma, acp: null as any }, "r1")).rejects.toThrow(
      "acpTunnel 未配置",
    );
  });

  it("throws when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(
      startAcpAgentExecution({ prisma, acp: { promptRun: vi.fn() } as any }, "r1"),
    ).rejects.toThrow("Run 不存在");
  });

  it("throws when roleKey specified but role missing", async () => {
    const run = makeRun({ kind: "test.run", stepRoleKey: "dev" });
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([makeAgent()]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
      task: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await expect(
      startAcpAgentExecution({ prisma, acp: { promptRun: vi.fn() } as any }, "r1"),
    ).rejects.toThrow("RoleTemplate 不存在");
  });

  it("renders step instruction for test.run and passes init env", async () => {
    const run = makeRun({ kind: "test.run" });
    const role = {
      key: "dev",
      displayName: "Dev",
      promptTemplate: "Role: {{workspace}}",
      envText: defaultRoleEnv,
      initScript: "echo hi",
      initTimeoutSeconds: 10,
    };
    const agent = makeAgent();

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end" }),
    } as any;
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([agent]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(role) },
      task: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await startAcpAgentExecution({ prisma, acp }, "r1");

    expect(renderTextTemplateFromDb).toHaveBeenCalledWith(
      { prisma },
      expect.objectContaining({
        key: "acp.stepInstruction.test.run",
        projectId: "p1",
        vars: { cmd: "pnpm test" },
      }),
    );

    expect(acp.promptRun).toHaveBeenCalledWith(
      expect.objectContaining({
        proxyId: "proxy-1",
        runId: "r1",
        cwd: "/workspace",
        init: expect.objectContaining({
          script: expect.stringContaining("echo hi"),
          timeout_seconds: 10,
          env: expect.objectContaining({
            GH_TOKEN: "role-gh",
            GITHUB_TOKEN: "role-gh",
            TUIXIU_GIT_AUTH_MODE: "https_pat",
            TUIXIU_RUN_ID: "r1",
            TUIXIU_RUN_BRANCH: "run-branch",
            TUIXIU_WORKSPACE: "C:/ws",
            TUIXIU_WORKSPACE_GUEST: "/workspace",
            TUIXIU_PROJECT_ID: "p1",
            TUIXIU_PROJECT_NAME: "P1",
            TUIXIU_REPO_URL: "https://example.com/repo.git",
            TUIXIU_BASE_BRANCH: "main",
            TUIXIU_ROLE_KEY: "dev",
          }),
        }),
      }),
    );

    const promptText = acp.promptRun.mock.calls[0][0].prompt?.[0]?.text as string;
    expect(promptText).toContain("CTX_PACK");
    expect(promptText).toContain("当前步骤:");
    expect(promptText).toContain("KEY=acp.stepInstruction.test.run");
    expect(promptText).toContain("任务标题:");
    expect(promptText).toContain("验收标准:");
    expect(promptText).toContain("约束条件:");
    expect(promptText).toContain("测试要求:");
  });

  it("uses code.review template vars", async () => {
    const run = makeRun({
      kind: "code.review",
      stepParams: {
        mode: "ai",
        githubPr: {
          number: 7,
          url: "https://github.com/o/r/pull/7",
          baseBranch: "main",
          headBranch: "run-1",
          headSha: "abcdef1234567890",
        },
      },
      stepRoleKey: null,
    });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([makeAgent()]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      task: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end" }),
    } as any;

    await startAcpAgentExecution({ prisma, acp }, "r1");

    expect(renderTextTemplateFromDb).toHaveBeenCalledWith(
      { prisma },
      expect.objectContaining({
        key: "acp.stepInstruction.code.review",
        vars: expect.objectContaining({
          who: "AI Reviewer（对抗式）",
          prNumber: 7,
          prUrl: "https://github.com/o/r/pull/7",
          baseBranch: "main",
          headBranch: "run-1",
          headShaShort: "abcdef123456",
        }),
      }),
    );
  });

  it("creates workspace when task workspace missing", async () => {
    const run = makeRun({ kind: "prd.generate" });
    (run as any).task.workspacePath = null;
    (run as any).task.branchName = null;

    const createWorkspace = vi.fn().mockResolvedValue({
      workspaceMode: "clone",
      workspacePath: "C:/ws2",
      branchName: "b2",
      baseBranch: "main",
    });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue(undefined),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([makeAgent()]),
        update: vi.fn().mockResolvedValue(undefined),
      },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue(makeRoleTemplate()) },
      task: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const acp = {
      promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end" }),
    } as any;
    await startAcpAgentExecution({ prisma, acp, createWorkspace }, "r1");

    expect(suggestRunKeyWithLlm).toHaveBeenCalled();
    expect(createWorkspace).toHaveBeenCalledWith({
      runId: "r1",
      baseBranch: "main",
      name: "run-key",
    });
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: expect.objectContaining({
        workspaceType: "clone",
        workspacePath: "C:/ws2",
        branchName: "b2",
      }),
    });
    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({
        workspaceType: "clone",
        workspacePath: "C:/ws2",
        branchName: "b2",
      }),
    });
  });
});
