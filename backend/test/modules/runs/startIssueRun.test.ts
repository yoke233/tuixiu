import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/utils/gitWorkspace.js", () => ({ suggestRunKeyWithLlm: vi.fn() }));

const { startIssueRun } = await import("../../../src/modules/runs/startIssueRun.js");
const { suggestRunKeyWithLlm } = await import("../../../src/utils/gitWorkspace.js");

function makeIssue(overrides?: Partial<any>) {
  return {
    id: "i1",
    projectId: "p1",
    status: "pending",
    title: "Issue",
    externalProvider: "github",
    externalNumber: 1,
    runs: [],
    project: {
      id: "p1",
      name: "P1",
      repoUrl: "https://example.com/repo.git",
      scmType: "github",
      defaultBranch: "main",
      enableRuntimeSkillsMounting: true,
      runGitCredentialId: "00000000-0000-0000-0000-000000000100",
      workspacePolicy: null,
      executionProfileId: null,
    },
    ...overrides,
  };
}

function makeAgent(overrides?: Partial<any>) {
  return {
    id: "a1",
    status: "online",
    currentLoad: 0,
    maxConcurrentRuns: 1,
    proxyId: "proxy-1",
    capabilities: { sandbox: { workspaceMode: "mount" } },
    ...overrides,
  };
}

describe("startIssueRun", () => {
  it("returns error when bundle policy missing source", async () => {
    const issue = makeIssue();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn() },
      agent: { findMany: vi.fn().mockResolvedValue([makeAgent()]), update: vi.fn() },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ key: "dev", workspacePolicy: "bundle" }) },
      run: { create: vi.fn(), update: vi.fn() },
    } as any;

    const res = await startIssueRun({
      prisma,
      acp: { promptRun: vi.fn() } as any,
      createWorkspace: vi.fn(),
      issueId: "i1",
      roleKey: "dev",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("BUNDLE_MISSING");
    }
    expect(prisma.run.create).not.toHaveBeenCalled();
  });

  it("returns RUN_GIT_CREDENTIAL_MISSING when git policy but project missing runGitCredentialId", async () => {
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    const issue = makeIssue();
    issue.project.runGitCredentialId = null;
    const agent = makeAgent({ capabilities: { sandbox: { workspaceMode: "git_clone" } } });

    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn() },
      agent: { findMany: vi.fn().mockResolvedValue([agent]), update: vi.fn() },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1", key: "dev", envText: "", workspacePolicy: "git" }) },
      run: { create: vi.fn(), update: vi.fn() },
    } as any;

    const res = await startIssueRun({
      prisma,
      acp: { promptRun: vi.fn() } as any,
      createWorkspace: vi.fn(),
      issueId: "i1",
      roleKey: "dev",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("RUN_GIT_CREDENTIAL_MISSING");
    }
    expect(prisma.run.create).not.toHaveBeenCalled();
  });

  it("empty policy skips repo env and writes skills inventory", async () => {
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    const issue = makeIssue();
    const agent = makeAgent();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn() },
      agent: { findMany: vi.fn().mockResolvedValue([agent]), update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1", key: "dev", envText: "", workspacePolicy: "empty" }) },
      run: { create: vi.fn().mockResolvedValue({ id: "run1" }), update: vi.fn().mockResolvedValue(undefined) },
      roleSkillBinding: {
        findMany: vi.fn().mockResolvedValue([
          { skillId: "s1", versionPolicy: "latest", pinnedVersionId: null },
        ]),
      },
      skill: {
        findMany: vi.fn().mockResolvedValue([{ id: "s1", name: "Demo", latestVersionId: "v1" }]),
      },
      skillVersion: {
        findMany: vi.fn().mockResolvedValue([
          { id: "v1", skillId: "s1", contentHash: "h1", storageUri: "/api/acp-proxy/skills/packages/h1.zip" },
        ]),
      },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({}) } as any;
    const createWorkspace = vi.fn().mockResolvedValue({
      workspacePath: "C:/ws",
      branchName: "run-branch",
      baseBranch: "main",
      workspaceMode: "worktree",
      gitAuthMode: "https_pat",
      timingsMs: {},
    });

    const res = await startIssueRun({
      prisma,
      acp,
      createWorkspace,
      issueId: "i1",
      roleKey: "dev",
    });

    expect(res.success).toBe(true);
    const initEnv = acp.promptRun.mock.calls[0][0].init.env as Record<string, string>;
    expect(initEnv.TUIXIU_REPO_URL).toBeUndefined();
    expect(initEnv.TUIXIU_GIT_AUTH_MODE).toBeUndefined();
    expect(initEnv.TUIXIU_INIT_ACTIONS).toEqual("ensure_workspace,write_inventory");

    const agentInputs = acp.promptRun.mock.calls[0][0].init.agentInputs as any;
    expect(agentInputs).toEqual(
      expect.objectContaining({
        version: 1,
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "workspace",
            apply: "bindMount",
            source: expect.objectContaining({ type: "hostPath" }),
            target: { root: "WORKSPACE", path: "." },
          }),
          expect.objectContaining({
            apply: "downloadExtract",
            source: { type: "httpZip", uri: "/api/acp-proxy/skills/packages/h1.zip", contentHash: "h1" },
            target: { root: "USER_HOME", path: ".codex/skills/demo" },
          }),
        ]),
      }),
    );

    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            contextInventory: expect.arrayContaining([
              expect.objectContaining({ source: "skills", version: "v1", hash: "h1" }),
            ]),
          }),
        }),
      }),
    );
  });

  it("merges RoleTemplate.agentInputs into init.agentInputs", async () => {
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    const issue = makeIssue();
    const agent = makeAgent();
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn() },
      agent: { findMany: vi.fn().mockResolvedValue([agent]), update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "r1",
          key: "dev",
          envText: "",
          workspacePolicy: "empty",
          agentInputs: {
            version: 1,
            envPatch: { HOME: "/root", USER: "agent" },
            items: [
              {
                id: "agents-md",
                apply: "writeFile",
                source: { type: "inlineText", text: "hi" },
                target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
              },
            ],
          },
        }),
      },
      run: { create: vi.fn().mockResolvedValue({ id: "run1" }), update: vi.fn().mockResolvedValue(undefined) },
      roleSkillBinding: { findMany: vi.fn().mockResolvedValue([]) },
      skill: { findMany: vi.fn().mockResolvedValue([]) },
      skillVersion: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({}) } as any;
    const createWorkspace = vi.fn().mockResolvedValue({
      workspacePath: "C:/ws",
      branchName: "run-branch",
      baseBranch: "main",
      workspaceMode: "worktree",
      gitAuthMode: "https_pat",
      timingsMs: {},
    });

    const res = await startIssueRun({
      prisma,
      acp,
      createWorkspace,
      issueId: "i1",
      roleKey: "dev",
    });

    expect(res.success).toBe(true);
    const agentInputs = acp.promptRun.mock.calls[0][0].init.agentInputs as any;
    expect(agentInputs.envPatch).toEqual({ HOME: "/root", USER: "agent" });
    expect(agentInputs.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "agents-md",
          apply: "writeFile",
          source: { type: "inlineText", text: "hi" },
          target: { root: "USER_HOME", path: ".codex/AGENTS.md" },
        }),
      ]),
    );
  });

  it("clamps keepalive ttl to minimum", async () => {
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    const issue = makeIssue();
    issue.project.enableRuntimeSkillsMounting = false;
    const agent = makeAgent({ capabilities: { sandbox: { workspaceMode: "git_clone" } } });
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn().mockResolvedValue(undefined) },
      agent: { findMany: vi.fn().mockResolvedValue([agent]), update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: "r1",
          key: "dev",
          envText: "FOO=bar\n",
        }),
      },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "00000000-0000-0000-0000-000000000100",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "tok",
        }),
      },
      run: { create: vi.fn().mockResolvedValue({ id: "run1" }), update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({}) } as any;
    const createWorkspace = vi.fn().mockResolvedValue({
      workspacePath: "C:/ws",
      branchName: "run-branch",
      baseBranch: "main",
      workspaceMode: "worktree",
      gitAuthMode: "https_pat",
      timingsMs: {},
    });

    const res = await startIssueRun({
      prisma,
      acp,
      createWorkspace,
      issueId: "i1",
      roleKey: "dev",
      keepaliveTtlSeconds: 10,
    });

    expect(res.success).toBe(true);
    expect(prisma.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          keepaliveTtlSeconds: 60,
        }),
      }),
    );
  });

  it("returns WORKSPACE_FAILED when createWorkspace missing", async () => {
    (suggestRunKeyWithLlm as any).mockResolvedValue("run-key");
    const issue = makeIssue();
    const agent = makeAgent({ capabilities: { sandbox: { workspaceMode: "git_clone" } } });
    const prisma = {
      issue: { findUnique: vi.fn().mockResolvedValue(issue), update: vi.fn().mockResolvedValue(undefined) },
      agent: { findMany: vi.fn().mockResolvedValue([agent]), update: vi.fn().mockResolvedValue(undefined) },
      roleTemplate: { findFirst: vi.fn().mockResolvedValue({ id: "r1", key: "dev", envText: "" }) },
      run: { create: vi.fn().mockResolvedValue({ id: "run1" }), update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const res = await startIssueRun({
      prisma,
      acp: { promptRun: vi.fn() } as any,
      issueId: "i1",
      roleKey: "dev",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("WORKSPACE_FAILED");
    }
    expect(prisma.run.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
        }),
      }),
    );
    expect(prisma.agent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentLoad: { decrement: 1 } }),
      }),
    );
  });
});
