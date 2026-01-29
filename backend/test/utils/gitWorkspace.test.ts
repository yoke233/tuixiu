import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function importFresh() {
  vi.resetModules();
  return await import("../../src/utils/gitWorkspace.js");
}

describe("gitWorkspace", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...envBackup };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...envBackup };
  });

  it("suggestRunKey builds stable ascii key", async () => {
    const { suggestRunKey } = await importFresh();
    expect(
      suggestRunKey({ title: "Hello World", externalProvider: "github", externalNumber: 9, runNumber: 2 }),
    ).toBe("gh-9-hello-world-r2");
    expect(suggestRunKey({ title: "", externalProvider: null, externalNumber: null, runNumber: 3 })).toBe("run-r3");
  });

  it("suggestRunKeyWithLlm returns fallback when disabled", async () => {
    const { suggestRunKeyWithLlm } = await importFresh();
    const res = await suggestRunKeyWithLlm({ title: "修复 漏洞", externalProvider: "github", externalNumber: 9, runNumber: 2 });
    expect(res).toBe("gh-9-r2");
  });

  it("suggestRunKeyWithLlm uses LLM slug for non-ascii titles when enabled", async () => {
    process.env.WORKTREE_NAME_LLM = "1";
    process.env.WORKTREE_NAME_LLM_API_KEY = "tok";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "fix-security" } }] }),
        text: async () => "",
      } as any),
    );

    const { suggestRunKeyWithLlm } = await importFresh();
    const res = await suggestRunKeyWithLlm({ title: "修复 漏洞", externalProvider: "github", externalNumber: 9, runNumber: 2 });
    expect(res).toBe("gh-9-fix-security-r2");
  });

  it("defaultRunBranchName prefixes run/", async () => {
    const { defaultRunBranchName } = await importFresh();
    expect(defaultRunBranchName("gh-1-demo-r1")).toBe("run/gh-1-demo-r1");
  });
});
