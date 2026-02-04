import { describe, expect, it, vi } from "vitest";

import { NativePlatform } from "../platform/native/nativePlatform.js";
import { ensureSessionForPrompt } from "./session.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd, _args, _opts, cb) => cb(null, { stdout: "", stderr: "" })),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => {}),
  open: vi.fn(async () => ({ close: async () => {} })),
  mkdtemp: vi.fn(async () => "C:/tmp/tuixiu-git-ssh-123"),
  chmod: vi.fn(async () => {}),
}));

vi.mock("../utils/gitHost.js", () => ({
  createHostGitEnv: vi.fn(async () => ({ env: {}, cleanup: async () => {} })),
}));

describe("runs/runRuntime", () => {
  it("mode=auto: session/new applies config option when offered", async () => {
    const sendRpc = vi.fn(async (method: string, params: any) => {
      if (method === "session/new") {
        return {
          sessionId: "s1",
          configOptions: [
            {
              id: "mode",
              currentValue: "ask",
              options: [{ value: "ask" }, { value: "auto" }],
            },
          ],
        };
      }
      if (method === "session/set_config_option") {
        return { ok: true };
      }
      throw new Error(`unexpected rpc: ${method} ${JSON.stringify(params)}`);
    });

    const ctx = {
      cfg: { sandbox: { terminalEnabled: false } },
      sandbox: { provider: "boxlite_oci", runtime: null, agentMode: "exec" },
      platform: new NativePlatform("win32"),
      send: vi.fn(),
      log: vi.fn(),
    } as any;

    const run = {
      runId: "r1",
      instanceName: "i1",
      keepaliveTtlSeconds: 0,
      expiresAt: null,
      lastUsedAt: Date.now(),
      opQueue: Promise.resolve(),
      hostWorkspacePath: "D:\\workspaces\\run-1",
      agent: { sendRpc } as any,
      suppressNextAcpExit: false,
      acpClient: null,
      initialized: true,
      initResult: { agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] },
      seenSessionIds: new Set<string>(),
      activePromptId: null,
    } as any;

    await ensureSessionForPrompt(ctx, run, { cwd: "/workspace", prompt: [{ type: "text", text: "hi" }] });

    expect(sendRpc).toHaveBeenCalledWith(
      "session/set_config_option",
      expect.objectContaining({ sessionId: "s1", configId: "mode", value: "auto" }),
    );

    // session/new 返回的 configOptions 应该被合成为一条 acp_update 上报给后端。
    expect(ctx.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "acp_update",
        run_id: "r1",
        session_id: "s1",
        update: expect.objectContaining({ sessionUpdate: "config_option_update" }),
      }),
    );
  });

  it("ensureHostWorkspaceGit uses worktree when provider=host and mode=worktree", async () => {
    const { ensureHostWorkspaceGit } = await import("./runRuntime.js");
    const { execFile } = await import("node:child_process");
    (execFile as any).mockClear();

    const ctx: any = {
      cfg: {
        sandbox: {
          workspaceProvider: "host",
          workspaceHostRoot: "C:/ws",
        },
      },
      sandbox: {},
      send: vi.fn(),
      log: vi.fn(),
    };

    const run: any = { runId: "r1", hostWorkspacePath: "C:/ws/run-r1" };

    await ensureHostWorkspaceGit(ctx, run, {
      TUIXIU_REPO_URL: "https://example.com/repo.git",
      TUIXIU_RUN_BRANCH: "run-branch",
      TUIXIU_BASE_BRANCH: "main",
      TUIXIU_WORKSPACE_MODE: "worktree",
    });

    const calls = (execFile as any).mock.calls.map((c: any[]) => c[1].join(" "));
    expect(calls.join("\n")).toContain("worktree add -B run-branch");
  });

  it("ensureHostWorkspaceGit uses clone when provider=host and mode=clone", async () => {
    const { ensureHostWorkspaceGit } = await import("./runRuntime.js");
    const { execFile } = await import("node:child_process");
    const { access } = await import("node:fs/promises");
    (execFile as any).mockClear();
    (access as any).mockImplementationOnce(async () => {
      throw new Error("missing");
    });

    const ctx: any = {
      cfg: {
        sandbox: {
          workspaceProvider: "host",
          workspaceHostRoot: "C:/ws",
        },
      },
      sandbox: {},
      send: vi.fn(),
      log: vi.fn(),
    };

    const run: any = { runId: "r1", hostWorkspacePath: "C:/ws/run-r1" };

    await ensureHostWorkspaceGit(ctx, run, {
      TUIXIU_REPO_URL: "https://example.com/repo.git",
      TUIXIU_RUN_BRANCH: "run-branch",
      TUIXIU_BASE_BRANCH: "main",
      TUIXIU_WORKSPACE_MODE: "clone",
    });

    const calls = (execFile as any).mock.calls.map((c: any[]) => c[1].join(" "));
    expect(calls.join("\n")).toContain("clone --branch main --single-branch");
  });
});
