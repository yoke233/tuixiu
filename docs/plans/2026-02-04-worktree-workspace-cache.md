# Worktree Workspace Cache Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 默认在 `sandbox.workspaceMode=mount` 时复用仓库缓存，并用 `git worktree` 创建每个 run 的 workspace，同时保留可切回旧的逐次 clone 行为。

**Architecture:** 在宿主机 `workspaceHostRoot/_repo-cache/<repo-hash>` 维护基础仓库缓存；每次 run 先 fetch 更新 `origin/<baseBranch>`，再用 `git worktree add -B <runBranch> <runPath> origin/<baseBranch>` 创建 workspace。删除 workspace 时解析 `.git` 指向的 `gitdir`，定位基础仓库后执行 `git worktree remove/prune`。新增配置 `sandbox.workspaceCheckout`（默认 `worktree`，可选 `clone`）。

**Tech Stack:** TypeScript (Node.js), git CLI, Vitest.

---

### Task 1: 新增 workspaceCheckout 配置并更新模板

**Files:**
- Modify: `acp-proxy/src/config.ts`
- Modify: `acp-proxy/src/config.test.ts`
- Modify: `acp-proxy/config.toml.example`
- Modify: `acp-proxy/config-local.toml`
- Modify: `acp-proxy/config-compose.toml`
- Modify: `acp-proxy/config-docker.toml`

**Step 1: Write the failing test**

```ts
it("defaults sandbox.workspaceCheckout to worktree", async () => {
  const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
  await writeFile(
    p,
    JSON.stringify({
      orchestrator_url: "ws://localhost:3000/ws/agent",
      heartbeat_seconds: 30,
      mock_mode: true,
      agent_command: ["node", "--version"],
      agent: { id: "codex-local-1", max_concurrent: 2 },
      sandbox: { provider: "boxlite_oci", image: "alpine:latest", workspaceMode: "mount" },
    }),
    "utf8",
  );
  const cfg = await loadConfig(p);
  expect(cfg.sandbox.workspaceCheckout).toBe("worktree");
});

it("parses sandbox.workspaceCheckout=clone", async () => {
  const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
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
        workspaceMode: "mount",
        workspaceCheckout: "clone",
      },
    }),
    "utf8",
  );
  const cfg = await loadConfig(p);
  expect(cfg.sandbox.workspaceCheckout).toBe("clone");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "workspaceCheckout"`
Expected: FAIL with "workspaceCheckout is undefined" (or similar)

**Step 3: Write minimal implementation**

```ts
workspaceCheckout: {
  doc: "Workspace checkout strategy (mount only)",
  format: ["worktree", "clone"],
  default: "worktree",
  env: "ACP_PROXY_SANDBOX_WORKSPACE_CHECKOUT",
},
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "workspaceCheckout"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/config.ts acp-proxy/src/config.test.ts acp-proxy/config.toml.example acp-proxy/config-local.toml acp-proxy/config-compose.toml acp-proxy/config-docker.toml
git commit -m "feat(acp-proxy): add workspace checkout strategy config"
```

---

### Task 2: 新增仓库缓存路径与锁工具

**Files:**
- Create: `acp-proxy/src/utils/repoCache.ts`
- Create: `acp-proxy/src/utils/repoCache.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { hashRepoUrl, resolveRepoCacheDir, resolveRepoLockPath } from "./repoCache.js";

describe("repoCache", () => {
  it("hashRepoUrl is stable", () => {
    expect(hashRepoUrl("https://example.com/repo.git")).toMatch(/^[a-f0-9]{40}$/);
    expect(hashRepoUrl("https://example.com/repo.git")).toBe(hashRepoUrl("https://example.com/repo.git"));
  });

  it("resolves cache dir under root", () => {
    const root = path.resolve("C:/tmp/workspaces");
    const dir = resolveRepoCacheDir(root, "https://example.com/repo.git");
    expect(dir.startsWith(path.join(root, "_repo-cache"))).toBe(true);
  });

  it("resolves lock path", () => {
    const root = path.resolve("C:/tmp/workspaces");
    const lock = resolveRepoLockPath(root, "https://example.com/repo.git");
    expect(lock.endsWith(".lock")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "repoCache"`
Expected: FAIL with module not found

**Step 3: Write minimal implementation**

```ts
import crypto from "node:crypto";
import path from "node:path";

export function hashRepoUrl(repoUrl: string): string {
  return crypto.createHash("sha1").update(repoUrl).digest("hex");
}

export function resolveRepoCacheDir(workspaceHostRoot: string, repoUrl: string): string {
  const cacheRoot = path.join(workspaceHostRoot, "_repo-cache");
  return path.join(cacheRoot, hashRepoUrl(repoUrl));
}

export function resolveRepoLockPath(workspaceHostRoot: string, repoUrl: string): string {
  return path.join(resolveRepoCacheDir(workspaceHostRoot, repoUrl), ".worktree.lock");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "repoCache"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/utils/repoCache.ts acp-proxy/src/utils/repoCache.test.ts
git commit -m "feat(acp-proxy): add repo cache helpers"
```

---

### Task 3: 新增 worktree 元数据解析工具

**Files:**
- Create: `acp-proxy/src/utils/gitWorktree.ts`
- Create: `acp-proxy/src/utils/gitWorktree.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseGitDirFromWorktree } from "./gitWorktree.js";

describe("gitWorktree", () => {
  it("parses gitdir from .git file content", () => {
    const content = "gitdir: C:/repo/.git/worktrees/run-1";
    const gitDir = parseGitDirFromWorktree(content);
    expect(gitDir).toBe(path.normalize("C:/repo/.git/worktrees/run-1"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "gitWorktree"`
Expected: FAIL with module not found

**Step 3: Write minimal implementation**

```ts
import path from "node:path";

export function parseGitDirFromWorktree(content: string): string | null {
  const trimmed = String(content ?? "").trim();
  if (!trimmed.startsWith("gitdir:")) return null;
  const raw = trimmed.slice("gitdir:".length).trim();
  if (!raw) return null;
  return path.normalize(raw);
}

export function resolveBaseRepoFromGitDir(gitDir: string): string | null {
  if (!gitDir) return null;
  // gitDir: <base>/.git/worktrees/<name>
  return path.resolve(gitDir, "..", "..", "..");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "gitWorktree"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/utils/gitWorktree.ts acp-proxy/src/utils/gitWorktree.test.ts
git commit -m "feat(acp-proxy): add git worktree helpers"
```

---

### Task 4: 让 ensureHostWorkspaceGit 默认走 worktree

**Files:**
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/runs/runTypes.ts`
- Test: `acp-proxy/src/runs/runRuntime.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

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
}));

describe("ensureHostWorkspaceGit", () => {
  it("uses git worktree when workspaceCheckout=worktree", async () => {
    const { ensureHostWorkspaceGit } = await import("./runRuntime.js");
    const { execFile } = await import("node:child_process");

    const ctx: any = {
      cfg: { sandbox: { workspaceMode: "mount", workspaceCheckout: "worktree" } },
      sandbox: {},
      log: console,
    };

    const run: any = { runId: "r1", hostWorkspacePath: "C:/ws/run-r1" };

    await ensureHostWorkspaceGit(ctx, run, {
      TUIXIU_REPO_URL: "https://example.com/repo.git",
      TUIXIU_RUN_BRANCH: "run-branch",
      TUIXIU_BASE_BRANCH: "main",
    });

    const calls = (execFile as any).mock.calls.map((c: any[]) => c[1].join(" "));
    expect(calls.join("\n")).toContain("worktree add -B run-branch");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "ensureHostWorkspaceGit"`
Expected: FAIL with "worktree add" not found

**Step 3: Write minimal implementation**

```ts
// runTypes.ts
hostRepoPath?: string | null;

// runRuntime.ts (核心逻辑示意)
const checkout = ctx.cfg.sandbox.workspaceCheckout ?? "worktree";
const rootResolved = path.resolve(root);

if (checkout === "worktree") {
  const baseRepoPath = resolveRepoCacheDir(rootResolved, repo);
  const lockPath = resolveRepoLockPath(rootResolved, repo);
  await withRepoLock(lockPath, async () => {
    await ensureBaseRepoUpdated(baseRepoPath, repo, baseBranch, hostEnv);
    await execFileAsync("git", ["-C", baseRepoPath, "worktree", "add", "-B", branch, hostWorkspacePath, `origin/${baseBranch}`], { env: hostEnv });
  });
  run.hostRepoPath = baseRepoPath;
} else {
  // 维持旧 clone 行为
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "ensureHostWorkspaceGit"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/runs/runRuntime.ts acp-proxy/src/runs/runTypes.ts acp-proxy/src/runs/runRuntime.test.ts
git commit -m "feat(acp-proxy): default to worktree checkout"
```

---

### Task 5: 删除 workspace 时清理 worktree

**Files:**
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Modify: `acp-proxy/src/utils/gitWorktree.ts`
- Test: `acp-proxy/src/utils/gitWorktree.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveBaseRepoFromGitDir } from "./gitWorktree.js";

describe("gitWorktree base repo", () => {
  it("resolves base repo from gitdir", () => {
    const gitDir = path.normalize("C:/repo/.git/worktrees/run-1");
    expect(resolveBaseRepoFromGitDir(gitDir)).toBe(path.normalize("C:/repo"));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "base repo"`
Expected: FAIL with unresolved export

**Step 3: Write minimal implementation**

```ts
export function resolveBaseRepoFromGitDir(gitDir: string): string | null {
  if (!gitDir) return null;
  return path.resolve(gitDir, "..", "..", "..");
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "base repo"`
Expected: PASS

**Step 5: Implement remove_workspace cleanup**

```ts
const gitFile = path.join(hostWorkspace, ".git");
try {
  const gitFileContent = await readFile(gitFile, "utf8");
  const gitDir = parseGitDirFromWorktree(gitFileContent);
  const baseRepo = gitDir ? resolveBaseRepoFromGitDir(gitDir) : null;
  if (baseRepo) {
    await execFileAsync("git", ["-C", baseRepo, "worktree", "remove", "--force", hostWorkspace]);
    await execFileAsync("git", ["-C", baseRepo, "worktree", "prune"]);
  }
} catch {
  // best effort, continue to rm -rf
}
```

**Step 6: Run targeted tests**

Run: `pnpm -C acp-proxy test -- -t "gitWorktree"`
Expected: PASS

**Step 7: Commit**

```bash
git add acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/utils/gitWorktree.ts acp-proxy/src/utils/gitWorktree.test.ts
git commit -m "feat(acp-proxy): cleanup worktree on remove_workspace"
```

---

### Task 6: 文档更新

**Files:**
- Modify: `acp-proxy/README.md`

**Step 1: Write the failing doc expectation (manual)**

- README 中明确：mount 模式默认使用 worktree + repo cache，可用 `sandbox.workspaceCheckout=clone` 回退。

**Step 2: Update README**

```md
- mount 模式默认使用 worktree（repo cache 位于 `workspaceHostRoot/_repo-cache`）
- 如需旧行为，设置 `sandbox.workspaceCheckout = "clone"`
```

**Step 3: Commit**

```bash
git add acp-proxy/README.md
git commit -m "docs(acp-proxy): document worktree workspace cache"
```

---

## Notes / Assumptions

- 仅影响 `sandbox.workspaceMode=mount`。`git_clone` 模式保持现状（由 init.script 处理）。
- worktree 删除是 best-effort；若 `.git` 不存在或解析失败，仍会 `rm -rf`。
- repo cache 与锁文件位于 `workspaceHostRoot/_repo-cache`，默认跟随现有宿主机根目录。

---

Plan complete and saved to `docs/plans/2026-02-04-worktree-workspace-cache.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints

Which approach?
