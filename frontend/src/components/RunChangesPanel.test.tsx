import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunChangesPanel } from "./RunChangesPanel";
import { AuthProvider } from "../auth/AuthProvider";
import type { Project, Run } from "../types";

function mockFetchJsonOnce(body: unknown) {
  (globalThis.fetch as any).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

describe("RunChangesPanel", () => {
  beforeEach(() => {
    localStorage.removeItem("authToken");
    localStorage.removeItem("authUser");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows conflict button and sends prompt to agent", async () => {
    localStorage.setItem("authToken", "test-token");
    localStorage.setItem("authUser", JSON.stringify({ id: "u1", username: "admin", role: "admin" }));

    const project: Project = {
      id: "p1",
      name: "demo",
      repoUrl: "https://github.com/octo-org/octo-repo.git",
      scmType: "github",
      defaultBranch: "main",
      hasGithubAccessToken: true,
      createdAt: "2026-01-25T00:00:00.000Z",
    };

    const run: Run = {
      id: "r1",
      issueId: "i1",
      agentId: "a1",
      executorType: "agent",
      status: "waiting_ci",
      startedAt: "2026-01-25T00:00:00.000Z",
      workspacePath: "D:\\repo\\.worktrees\\run-r1",
      branchName: "run/r1",
      artifacts: [
        {
          id: "pr-1",
          runId: "r1",
          type: "pr",
          content: {
            webUrl: "https://github.com/octo-org/octo-repo/pull/12",
            state: "open",
            number: 12,
            sourceBranch: "run/r1",
            targetBranch: "main",
            mergeable: false,
            mergeable_state: "dirty",
          },
          createdAt: "2026-01-25T00:00:00.000Z",
        },
      ],
    };

    // initial load changes
    mockFetchJsonOnce({ success: true, data: { baseBranch: "main", branch: "run/r1", files: [] } });
    // prompt
    mockFetchJsonOnce({ success: true, data: { ok: true } });
    // refresh run after prompt
    mockFetchJsonOnce({ success: true, data: { run } });

    render(
      <AuthProvider>
        <MemoryRouter>
          <RunChangesPanel runId="r1" project={project} run={run} />
        </MemoryRouter>
      </AuthProvider>
    );

    const btn = await screen.findByRole("button", { name: "让 Agent 解决冲突" });
    btn.click();

    await waitFor(() => {
      const calls = (globalThis.fetch as any).mock.calls as Array<[string, RequestInit | undefined]>;
      const call = calls.find(([url, init]) => url.includes("/runs/r1/prompt") && init?.method === "POST");
      expect(call).toBeTruthy();

      const init = call![1] as RequestInit;
      const body = JSON.parse(String(init.body ?? "{}")) as any;
      expect(body.prompt?.[0]?.type).toBe("text");
      expect(String(body.prompt?.[0]?.text ?? "")).toMatch(/解决合并冲突/);
      expect(String(body.prompt?.[0]?.text ?? "")).toMatch(/git merge origin\/main/);
    });
  });

  it("shows PR link even when API is disabled (no token)", async () => {
    const project: Project = {
      id: "p1",
      name: "demo",
      repoUrl: "https://github.com/octo-org/octo-repo.git",
      scmType: "github",
      defaultBranch: "main",
      hasGithubAccessToken: false,
      createdAt: "2026-01-25T00:00:00.000Z",
    };

    const run: Run = {
      id: "r1",
      issueId: "i1",
      agentId: "a1",
      executorType: "agent",
      status: "waiting_ci",
      startedAt: "2026-01-25T00:00:00.000Z",
      workspacePath: "D:\\repo\\.worktrees\\run-r1",
      branchName: "run/r1",
      artifacts: [
        {
          id: "pr-1",
          runId: "r1",
          type: "pr",
          content: {
            webUrl: "https://github.com/octo-org/octo-repo/pull/12",
            state: "open",
            number: 12,
            sourceBranch: "run/r1",
            targetBranch: "main",
          },
          createdAt: "2026-01-25T00:00:00.000Z",
        },
      ],
    };

    mockFetchJsonOnce({ success: true, data: { baseBranch: "main", branch: "run/r1", files: [] } });

    render(
      <AuthProvider>
        <MemoryRouter>
          <RunChangesPanel runId="r1" project={project} run={run} />
        </MemoryRouter>
      </AuthProvider>,
    );

    const link = await screen.findByRole("link", { name: /打开 PR/i });
    expect(link.getAttribute("href")).toBe("https://github.com/octo-org/octo-repo/pull/12");

    expect(screen.queryByRole("button", { name: "同步 PR 状态" })).toBeNull();
    expect(screen.queryByRole("button", { name: "发起合并审批" })).toBeNull();
  });
});

