---
title: "ACP Proxy Git Ops Implementation Plan"
owner: "@yoke233"
status: "archived"
last_reviewed: "2026-01-30"
---

# ACP Proxy Git Ops Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 允许通过 acp-proxy 配置选择 git_clone 工作区模式，让代码拉取/分支创建/提交/推送由 sandbox 内完成，同时后端不会误用宿主机 workspace。

**Architecture:** 后端根据 Agent capabilities.sandbox.workspaceMode 决定 workspace 由宿主机创建还是由 sandbox 内 init 脚本完成。acp-proxy 仅暴露 workspaceMode 能力；当 workspaceMode=git_clone 时，后端为 Run 写入虚拟 workspacePath=/workspace，并在 PR 流程里跳过宿主机 git push。

**Tech Stack:** TypeScript, Fastify, Zod, Vitest, BoxLite/OCI, ACP

---

### Task 1: acp-proxy 配置与能力支持 git_clone

**Files:**
- Modify: `acp-proxy/src/config.ts`
- Modify: `acp-proxy/src/config.test.ts`
- Modify: `acp-proxy/src/runProxyCli.ts`
- Modify: `acp-proxy/config.toml.example`
- Modify: `acp-proxy/config.toml`

**Step 1: Write the failing test**

```ts
it("parses sandbox.workspaceMode=git_clone", async () => {
  const p = path.join(
    tmpdir(),
    `acp-proxy-config-${Date.now()}-${Math.random()}.json`,
  );
  await writeFile(
    p,
    JSON.stringify({
      orchestrator_url: "ws://localhost:3000/ws/agent",
      heartbeat_seconds: 30,
      mock_mode: true,
      agent_command: ["node", "--version"],
      agent: { id: "codex-local-1", max_concurrent: 2 },
      sandbox: {
        provider: "boxlite_oci",
        image: "alpine:latest",
        workspaceMode: "git_clone",
      },
    }),
    "utf8",
  );

  const cfg = await loadConfig(p);
  expect(cfg.sandbox.workspaceMode).toBe("git_clone");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "workspaceMode=git_clone"`
Expected: FAIL with Zod enum validation error for workspaceMode.

**Step 3: Write minimal implementation**

```ts
// acp-proxy/src/config.ts
workspaceMode: z.enum(["mount", "git_clone"]).default("mount"),

// ... in override schema
workspaceMode: z.enum(["mount", "git_clone"]).optional(),
```

```ts
// acp-proxy/src/runProxyCli.ts
const sandboxCaps: Record<string, unknown> = {
  ...baseSandbox,
  provider: cfg.sandbox.provider,
  terminalEnabled: cfg.sandbox.terminalEnabled,
  agentMode: sandbox.agentMode,
  image: cfg.sandbox.image ?? null,
  workingDir: cfg.sandbox.workingDir ?? null,
  workspaceMode: cfg.sandbox.workspaceMode ?? "mount",
};
if (cfg.sandbox.provider === "container_oci") sandboxCaps.runtime = cfg.sandbox.runtime ?? "docker";
```

```toml
# acp-proxy/config.toml.example
[sandbox]
# workspaceMode: "mount" | "git_clone"
workspaceMode = "mount"
```

```toml
# acp-proxy/config.toml
[sandbox]
workspaceMode = "mount"
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "workspaceMode"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/config.ts acp-proxy/src/config.test.ts acp-proxy/src/runProxyCli.ts acp-proxy/config.toml.example acp-proxy/config.toml
git commit -m "feat(acp-proxy): allow git_clone workspace mode"
```

---

### Task 2: 后端识别 git_clone 并生成虚拟 workspace

**Files:**
- Create: `backend/src/utils/sandboxCaps.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/test/utils/sandboxCaps.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { getSandboxWorkspaceMode, isSandboxGitClone } from "../../src/utils/sandboxCaps.js";

describe("sandboxCaps", () => {
  it("detects git_clone", () => {
    const caps = { sandbox: { provider: "container_oci", workspaceMode: "git_clone" } };
    expect(getSandboxWorkspaceMode(caps)).toBe("git_clone");
    expect(isSandboxGitClone(caps)).toBe(true);
  });

  it("returns null/false for missing or mount", () => {
    expect(getSandboxWorkspaceMode(null)).toBe(null);
    expect(isSandboxGitClone({ sandbox: { workspaceMode: "mount" } })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "sandboxCaps"`
Expected: FAIL because module `sandboxCaps` not found.

**Step 3: Write minimal implementation**

```ts
// backend/src/utils/sandboxCaps.ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type SandboxWorkspaceMode = "mount" | "git_clone";

export function getSandboxWorkspaceMode(caps: unknown): SandboxWorkspaceMode | null {
  if (!isRecord(caps)) return null;
  const sandbox = caps.sandbox;
  if (!isRecord(sandbox)) return null;
  const raw = String((sandbox as any).workspaceMode ?? "").trim();
  if (raw === "git_clone") return "git_clone";
  if (raw === "mount") return "mount";
  return null;
}

export function isSandboxGitClone(caps: unknown): boolean {
  return getSandboxWorkspaceMode(caps) === "git_clone";
}
```

```ts
// backend/src/index.ts (createWorkspace 内部)
const run = await prisma.run.findUnique({
  where: { id: runId },
  include: { issue: { include: { project: true } }, agent: true },
});
const project = (run as any)?.issue?.project;
if (!project) {
  throw new Error("Run 对应的 Project 不存在");
}

const caps = (run as any)?.agent?.capabilities ?? null;
if (isSandboxGitClone(caps)) {
  const branchName = defaultRunBranchName(name);
  const resolvedBase = String(baseBranch ?? "").trim() || String(project.defaultBranch ?? "main");
  return {
    workspaceMode: "clone",
    workspacePath: "/workspace",
    branchName,
    baseBranch: resolvedBase,
    gitAuthMode: resolveGitAuthMode({
      repoUrl: String(project.repoUrl ?? ""),
      scmType: project.scmType ?? null,
      gitAuthMode: project.gitAuthMode ?? null,
      githubAccessToken: project.githubAccessToken ?? null,
      gitlabAccessToken: project.gitlabAccessToken ?? null,
    }),
    timingsMs: { totalMs: 0 },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "sandboxCaps"`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/utils/sandboxCaps.ts backend/src/index.ts backend/test/utils/sandboxCaps.test.ts
git commit -m "feat(backend): support git_clone workspace metadata"
```

---

### Task 3: PR 流程跳过宿主机 git push（任何 git_clone）

**Files:**
- Modify: `backend/src/modules/scm/runReviewRequest.ts`
- Test: `backend/test/runReviewRequest.test.ts`

**Step 1: Write the failing test**

```ts
it("git_clone in capabilities: skips gitPush for non-boxlite", async () => {
  const { prisma, gitPush, parseRepo, createPullRequest } = makeDeps({
    run: {
      agent: {
        capabilities: { sandbox: { provider: "container_oci", workspaceMode: "git_clone" } },
      },
    },
  });

  const res = await createReviewRequestForRun(
    { prisma, gitPush, github: { parseRepo, createPullRequest } } as any,
    "r1",
    {},
  );

  expect(res.success).toBe(true);
  expect(gitPush).not.toHaveBeenCalled();
  expect(createPullRequest).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "git_clone in capabilities"`
Expected: FAIL because current logic only skips BoxLite.

**Step 3: Write minimal implementation**

```ts
// backend/src/modules/scm/runReviewRequest.ts
import { isSandboxGitClone } from "../../utils/sandboxCaps.js";

function isSandboxGitCloneRun(run: any): boolean {
  const assignedCaps = run?.issue?.assignedAgent?.capabilities;
  const runCaps = run?.agent?.capabilities;
  return isSandboxGitClone(assignedCaps ?? runCaps);
}

// in createReviewRequestForRun
if (!isSandboxGitCloneRun(runAny)) {
  await deps.gitPush({ cwd: runAny.workspacePath ?? process.cwd(), branch, project });
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "git_clone in capabilities"`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/modules/scm/runReviewRequest.ts backend/test/runReviewRequest.test.ts
git commit -m "fix(backend): skip git push for git_clone runs"
```
