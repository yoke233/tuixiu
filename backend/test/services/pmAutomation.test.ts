import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPmAutomation } from "../../src/modules/pm/pmAutomation.js";

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

describe("PM automation", () => {
  const originalEnv = {
    PM_LLM_BASE_URL: process.env.PM_LLM_BASE_URL,
    PM_LLM_API_KEY: process.env.PM_LLM_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
  };
  const defaultRoleEnv = "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=role-gh\n";

  beforeEach(() => {
    delete process.env.PM_LLM_BASE_URL;
    delete process.env.PM_LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (typeof v === "string") process.env[k] = v;
      else delete process.env[k];
    }
  });

  it("dispatch starts run and stores pm_analysis event (fallback mode)", async () => {
    const createWorkspace = vi.fn().mockResolvedValue({
      repoRoot: "D:\\repo",
      branchName: "run/t1-r1",
      workspacePath: "D:\\repo\\.worktrees\\run-t1-r1",
      workspaceMode: "worktree",
    });

    const prisma = {
      issue: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: "i1", status: "pending", archivedAt: null })
          .mockResolvedValueOnce({
            id: "i1",
            projectId: "p1",
            title: "t1",
            description: null,
            acceptanceCriteria: [],
            constraints: [],
            testRequirements: null,
            project: {
              id: "p1",
              defaultRoleKey: "dev",
              defaultBranch: "main",
              repoUrl: "https://example.com/repo",
              scmType: "github",
              runGitCredentialId: "c-run",
            },
          })
          .mockResolvedValueOnce({
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
              defaultRoleKey: "dev",
              defaultBranch: "main",
              repoUrl: "https://example.com/repo",
              scmType: "github",
              runGitCredentialId: "c-run",
            },
          }),
        update: vi.fn().mockResolvedValue({ id: "i1" }),
      },
      roleTemplate: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({
          key: "dev",
          displayName: "Dev",
          promptTemplate: "",
          initScript: null,
          initTimeoutSeconds: 300,
          envText: defaultRoleEnv,
        }),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "a1",
            proxyId: "proxy-1",
            name: "agent-1",
            status: "online",
            currentLoad: 0,
            maxConcurrentRuns: 1,
            capabilities: {},
          },
        ]),
        update: vi.fn().mockResolvedValue({ id: "a1" }),
      },
      run: {
        create: vi.fn().mockResolvedValue({ id: "r1" }),
        update: vi.fn().mockResolvedValue({ id: "r1" }),
      },
      event: {
        create: vi.fn().mockResolvedValue({}),
      },
      artifact: {
        create: vi.fn().mockResolvedValue({ id: "art-1" }),
      },
      gitCredential: {
        findUnique: vi.fn().mockResolvedValue({
          id: "c-run",
          projectId: "p1",
          gitAuthMode: "https_pat",
          githubAccessToken: "gh-run",
        }),
      },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }) } as any;
    const pm = createPmAutomation({ prisma, acp, createWorkspace });

    const res = await pm.dispatch("i1", "test");
    expect((res as any).success).toBe(true);

    expect(acp.promptRun).toHaveBeenCalledTimes(1);
    expect(extractPromptText(acp.promptRun.mock.calls[0][0].prompt)).toContain("（系统/PM）以下为 PM 自动分析结果");

    expect(prisma.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "pm.analysis.generated" }),
      }),
    );
  });

  it("dispatch skips when policy disables autoStartIssue (non-manual reason)", async () => {
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          status: "pending",
          archivedAt: null,
          project: {
            branchProtection: {
              pmPolicy: {
                version: 1,
                automation: { autoStartIssue: false },
                approvals: { requireForActions: ["merge_pr"] },
                sensitivePaths: [],
              },
            },
          },
        }),
      },
    } as any;

    const acp = { promptRun: vi.fn().mockResolvedValue({ sessionId: "s1", stopReason: "end_turn" }) } as any;
    const pm = createPmAutomation({ prisma, acp });

    const res = await pm.dispatch("i1", "ui_create");
    expect(res).toEqual({ success: true, data: { skipped: true, reason: "POLICY_AUTO_START_DISABLED" } });
    expect(acp.promptRun).not.toHaveBeenCalled();
  });
});
