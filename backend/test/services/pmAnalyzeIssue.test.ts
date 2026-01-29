import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeIssueForPm } from "../../src/modules/pm/pmAnalyzeIssue.js";

describe("PM analyzeIssueForPm", () => {
  const originalEnv = {
    PM_LLM_BASE_URL: process.env.PM_LLM_BASE_URL,
    PM_LLM_MODEL: process.env.PM_LLM_MODEL,
    PM_LLM_API_KEY: process.env.PM_LLM_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CODEX_API_KEY: process.env.CODEX_API_KEY,
  };

  beforeEach(() => {
    delete process.env.PM_LLM_BASE_URL;
    delete process.env.PM_LLM_MODEL;
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

  it("returns fallback when llm disabled", async () => {
    const prisma = {
      issue: {
        findUnique: vi.fn().mockResolvedValue({
          id: "i1",
          projectId: "p1",
          title: "t1",
          description: null,
          acceptanceCriteria: [],
          constraints: [],
          testRequirements: null,
          project: { id: "p1", defaultRoleKey: "dev" },
        }),
      },
      roleTemplate: { findMany: vi.fn().mockResolvedValue([]) },
      agent: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    const res = await analyzeIssueForPm({ prisma, issueId: "i1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.meta.source).toBe("fallback");
    expect(res.analysis.summary).toBe("t1");
    expect(res.analysis.risk).toBe("medium");
    expect(res.analysis.recommendedRoleKey).toBe("dev");
  });

  it("uses llm and sanitizes recommendations against allowed sets", async () => {
    process.env.PM_LLM_API_KEY = "sk-test";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "分析一下",
                risk: "low",
                questions: ["请确认验收标准"],
                recommendedRoleKey: "not-exist",
                recommendedAgentId: "a1",
              }),
            },
          },
        ],
      }),
    });
    const originalFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchMock;

    try {
      const prisma = {
        issue: {
          findUnique: vi.fn().mockResolvedValue({
            id: "i1",
            projectId: "p1",
            title: "t1",
            description: "d1",
            acceptanceCriteria: [],
            constraints: [],
            testRequirements: null,
            project: { id: "p1", defaultRoleKey: "dev" },
          }),
        },
        roleTemplate: {
          findMany: vi.fn().mockResolvedValue([{ key: "dev", displayName: "Dev", description: "dev role" }]),
        },
        agent: {
          findMany: vi.fn().mockResolvedValue([
            { id: "a1", name: "agent1", currentLoad: 0, maxConcurrentRuns: 1, capabilities: {} },
          ]),
        },
      } as any;

      const res = await analyzeIssueForPm({ prisma, issueId: "i1" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.meta.source).toBe("llm");
      expect(res.analysis.risk).toBe("low");
      expect(res.analysis.recommendedAgentId).toBe("a1");
      expect(res.analysis.recommendedRoleKey).toBe(null);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});

