import { beforeEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";

vi.mock("node:child_process", () => {
  const execFile = vi.fn();

  (execFile as any)[promisify.custom] = (file: string, args: string[], options?: any) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err: any, stdout: any, stderr: any) => {
        if (err) {
          (err as any).stdout = stdout;
          (err as any).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return { execFile };
});

vi.mock("../../src/utils/gitAuth.js", () => ({ createGitProcessEnv: vi.fn() }));
vi.mock("../../src/modules/scm/runReviewRequest.js", () => ({ createReviewRequestForRun: vi.fn() }));
vi.mock("../../src/modules/workflow/taskProgress.js", () => ({ advanceTaskFromRunTerminal: vi.fn() }));
vi.mock("../../src/modules/artifacts/artifactPublish.js", () => ({ planArtifactPublish: vi.fn(), publishArtifact: vi.fn() }));
vi.mock("../../src/modules/approvals/approvalRequests.js", () => ({
  requestCreatePrApproval: vi.fn(),
  requestPublishArtifactApproval: vi.fn(),
}));
vi.mock("../../src/modules/pm/pmPolicy.js", () => ({ getPmPolicyFromBranchProtection: vi.fn() }));
vi.mock("../../src/modules/pm/pmSensitivePaths.js", () => ({ computeSensitiveHitFromPaths: vi.fn() }));

const { startSystemExecution } = await import("../../src/executors/systemExecutor.js");
const { execFile } = await import("node:child_process");
const { createGitProcessEnv } = await import("../../src/utils/gitAuth.js");
const { createReviewRequestForRun } = await import("../../src/modules/scm/runReviewRequest.js");
const { advanceTaskFromRunTerminal } = await import("../../src/modules/workflow/taskProgress.js");
const { planArtifactPublish, publishArtifact } = await import("../../src/modules/artifacts/artifactPublish.js");
const { requestCreatePrApproval, requestPublishArtifactApproval } = await import("../../src/modules/approvals/approvalRequests.js");
const { getPmPolicyFromBranchProtection } = await import("../../src/modules/pm/pmPolicy.js");
const { computeSensitiveHitFromPaths } = await import("../../src/modules/pm/pmSensitivePaths.js");

function makePolicy(opts?: Partial<any>) {
  return {
    policy: {
      approvals: { requireForActions: [], escalateOnSensitivePaths: [] },
      sensitivePaths: [],
      ...opts,
    },
  };
}

describe("systemExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (getPmPolicyFromBranchProtection as any).mockReturnValue(makePolicy());
    (createGitProcessEnv as any).mockResolvedValue({ env: { GIT_TERMINAL_PROMPT: "0" }, cleanup: vi.fn().mockResolvedValue(undefined) });
    (execFile as any).mockImplementation((file: string, args: string[], options: any, cb: any) => cb(null, "", ""));
    (advanceTaskFromRunTerminal as any).mockResolvedValue({ handled: true });
  });

  it("throws when run missing", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue(null) } } as any;
    await expect(startSystemExecution({ prisma }, "r1")).rejects.toThrow("Run 不存在");
  });

  it("throws when run missing step/task/issue/project", async () => {
    const prisma = { run: { findUnique: vi.fn().mockResolvedValue({ id: "r1", step: null }) } } as any;
    await expect(startSystemExecution({ prisma }, "r1")).rejects.toThrow("Run 缺少 step/task/issue/project");
  });

  it("pr.create returns executed=false when approval required", async () => {
    (getPmPolicyFromBranchProtection as any).mockReturnValue(makePolicy({ approvals: { requireForActions: ["create_pr"], escalateOnSensitivePaths: [] } }));

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "pr.create", params: {} },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
      },
      step: { update: vi.fn().mockResolvedValue(undefined) },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const res = await startSystemExecution({ prisma }, "r1");
    expect(res).toEqual({ executed: false });
    expect(requestCreatePrApproval).toHaveBeenCalledWith({
      prisma,
      runId: "r1",
      requestedBy: "system_step",
      payload: {},
    });
    expect(prisma.step.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "waiting_human" } });
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "reviewing" } });
  });

  it("pr.create executes when no approval required (covers default git push)", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    (createGitProcessEnv as any).mockResolvedValueOnce({ env: { GIT_TERMINAL_PROMPT: "0" }, cleanup });

    (createReviewRequestForRun as any).mockImplementation(async (deps: any) => {
      await deps.gitPush({ cwd: "C:/repo", branch: "run-branch", project: { repoUrl: "https://example.com/repo.git" } });
      return { success: true, data: {} };
    });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "pr.create", params: {} },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", repoUrl: "https://example.com/repo.git", branchProtection: "" } } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const res = await startSystemExecution({ prisma }, "r1");
    expect(res).toEqual({ executed: true });

    expect(execFile).toHaveBeenCalledWith("git", ["push", "-u", "origin", "run-branch"], { cwd: "C:/repo", env: { GIT_TERMINAL_PROMPT: "0" } }, expect.any(Function));
    expect(cleanup).toHaveBeenCalled();

    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(advanceTaskFromRunTerminal).toHaveBeenCalledWith({ prisma }, "r1", "completed");
  });

  it("pr.create throws when createReviewRequestForRun fails", async () => {
    (createReviewRequestForRun as any).mockResolvedValueOnce({ success: false, error: { code: "X", message: "bad" } });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "pr.create", params: {} },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
      },
    } as any;

    await expect(startSystemExecution({ prisma }, "r1")).rejects.toThrow("X: bad");
  });

  it("report.publish throws when no artifact candidates", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "report.publish", params: { kind: "analysis" } },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([]) },
    } as any;

    await expect(startSystemExecution({ prisma }, "r1")).rejects.toThrow("没有可发布的产物（report/ci_result）");
  });

  it("report.publish returns executed=false when sensitive path requires approval", async () => {
    (getPmPolicyFromBranchProtection as any).mockReturnValue(
      makePolicy({ sensitivePaths: ["secret/**"], approvals: { requireForActions: [], escalateOnSensitivePaths: ["publish_artifact"] } }),
    );
    (planArtifactPublish as any).mockResolvedValueOnce({ success: true, data: { kind: "analysis", path: "secret/out.md" } });
    (computeSensitiveHitFromPaths as any).mockReturnValueOnce({ patterns: Array.from({ length: 30 }, (_, i) => `p${i}`), matchedFiles: Array.from({ length: 80 }, (_, i) => `f${i}`) });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "report.publish", params: { kind: "analysis" } },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      artifact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "a1", type: "report", content: { kind: "analysis", markdown: "x" } },
        ]),
      },
      step: { update: vi.fn().mockResolvedValue(undefined) },
      issue: { update: vi.fn().mockResolvedValue(undefined) },
    } as any;

    const res = await startSystemExecution({ prisma }, "r1");
    expect(res).toEqual({ executed: false });
    expect(requestPublishArtifactApproval).toHaveBeenCalledWith({
      prisma,
      artifactId: "a1",
      requestedBy: "system_step",
      payload: {
        path: "secret/out.md",
        sensitive: {
          patterns: expect.any(Array),
          matchedFiles: expect.any(Array),
        },
      },
    });
    expect(prisma.step.update).toHaveBeenCalledWith({ where: { id: "s1" }, data: { status: "waiting_human" } });
    expect(prisma.issue.update).toHaveBeenCalledWith({ where: { id: "i1" }, data: { status: "reviewing" } });
  });

  it("report.publish executes when approval not required", async () => {
    (planArtifactPublish as any).mockResolvedValueOnce({ success: true, data: { kind: "analysis", path: "docs/out.md" } });
    (publishArtifact as any).mockResolvedValueOnce({ success: true, data: { path: "docs/out.md", commitSha: "sha" } });

    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "report.publish", params: { kind: "analysis" } },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      artifact: { findMany: vi.fn().mockResolvedValue([{ id: "a1", type: "report", content: { kind: "analysis", markdown: "x" } }]) },
    } as any;

    const res = await startSystemExecution({ prisma }, "r1");
    expect(res).toEqual({ executed: true });
    expect(publishArtifact).toHaveBeenCalledWith({ prisma }, "a1");
    expect(prisma.run.update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: expect.objectContaining({ status: "completed" }),
    });
    expect(advanceTaskFromRunTerminal).toHaveBeenCalledWith({ prisma }, "r1", "completed");
  });

  it("throws for unsupported system step kind", async () => {
    const prisma = {
      run: {
        findUnique: vi.fn().mockResolvedValue({
          id: "r1",
          step: { id: "s1", kind: "unknown", params: {} },
          task: { id: "t1", issue: { id: "i1", project: { id: "p1", branchProtection: "" } } },
          artifacts: [],
        }),
      },
    } as any;

    await expect(startSystemExecution({ prisma }, "r1")).rejects.toThrow("不支持的 system step");
  });
});
