import { describe, expect, it } from "vitest";

import { buildRecoveryInit } from "../../../src/modules/runs/runRecovery.js";

function makePrisma(role?: any) {
  return {
    roleTemplate: {
      findFirst: async () => role ?? null,
    },
  } as any;
}

describe("runRecovery", () => {
  it("returns undefined when project or role key missing", async () => {
    const init1 = await buildRecoveryInit({
      prisma: makePrisma(),
      run: {},
      issue: {},
      project: null,
    });
    expect(init1).toBeUndefined();

    const init2 = await buildRecoveryInit({
      prisma: makePrisma(),
      run: {},
      issue: { projectId: "p1", project: { defaultRoleKey: "" } },
      project: { defaultRoleKey: "" },
    });
    expect(init2).toBeUndefined();
  });

  it("returns undefined when role not found", async () => {
    const init = await buildRecoveryInit({
      prisma: makePrisma(null),
      run: { metadata: { roleKey: "dev" } },
      issue: { projectId: "p1", project: { defaultRoleKey: "dev" } },
      project: { defaultRoleKey: "dev" },
    });
    expect(init).toBeUndefined();
  });

  it("builds env and script for git auth", async () => {
    const role = {
      key: "dev",
      envText: "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=role-gh\n",
      initScript: "echo role-init",
      initTimeoutSeconds: 120,
    };

    const project = {
      id: "p1",
      name: "Proj",
      repoUrl: "https://example.com/repo.git",
      scmType: "github",
      defaultBranch: "main",
      defaultRoleKey: "fallback",
      githubAccessToken: "proj-gh",
    };

    const run = {
      id: "r1",
      metadata: { roleKey: "dev" },
      workspacePath: "/host/ws",
      branchName: "",
      artifacts: [{ type: "branch", content: { branch: "from-art" } }],
      agent: { capabilities: { sandbox: { workspaceMode: "git_clone" } } },
    };

    const init = await buildRecoveryInit({
      prisma: makePrisma(role),
      run,
      issue: { projectId: "p1", project },
      project,
    });

    expect(init?.env.TUIXIU_ROLE_KEY).toBe("dev");
    expect(init?.env.TUIXIU_RUN_BRANCH).toBe("from-art");
    expect(init?.env.TUIXIU_GIT_AUTH_MODE).toBe("https_pat");
    expect(init?.env.TUIXIU_GIT_HTTP_PASSWORD).toBe("proj-gh");
    expect(init?.env.TUIXIU_WORKSPACE_GUEST).toBe("/workspace/run-r1");
    expect(init?.script).toContain("init_step");
    expect(init?.script).toContain("role-init");
    expect(init?.timeout_seconds).toBe(120);
  });

  it("falls back to role token when project token missing", async () => {
    const role = {
      key: "dev",
      envText: "TUIXIU_GIT_AUTH_MODE=https_pat\nGH_TOKEN=role-gh\n",
    };

    const project = {
      id: "p1",
      name: "Proj",
      repoUrl: "https://example.com/repo.git",
      scmType: "github",
      defaultBranch: "main",
      defaultRoleKey: "dev",
      githubAccessToken: null,
    };

    const run = { id: "r2", metadata: { roleKey: "dev" }, workspacePath: "/host/ws" };

    const init = await buildRecoveryInit({
      prisma: makePrisma(role),
      run,
      issue: { projectId: "p1", project },
      project,
    });

    expect(init?.env.TUIXIU_GIT_HTTP_PASSWORD).toBe("role-gh");
  });
});
