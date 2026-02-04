# Workspace Provider/Mode Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一 workspace 命名与控制权：服务端下发 `workspaceMode=worktree|clone`，acp-proxy 只配置 `workspaceProvider=host|guest` 并按规则执行，移除旧字段与兼容逻辑。

**Architecture:** 把“策略（worktree/clone）”与“执行位置（host/guest）”分离；后端负责决定策略并下发到 init.env；acp-proxy 仅依据 provider 与 mode 执行 host worktree/clone 或 guest clone。旧的 `sandbox.workspaceMode=mount|git_clone` 与 `workspaceCheckout` 全部删除，不做兼容。

**Tech Stack:** TypeScript (Node.js), Fastify, Prisma, Vitest.

---

### Task 1: acp-proxy 配置与模板改为 workspaceProvider

**Files:**
- Modify: `acp-proxy/src/config.ts`
- Modify: `acp-proxy/src/config.test.ts`
- Modify: `acp-proxy/config.toml.example`
- Modify: `acp-proxy/config-local.toml`
- Modify: `acp-proxy/config-compose.toml`
- Modify: `acp-proxy/config-docker.toml`
- Modify: `acp-proxy/README.md`

**Step 1: Write the failing test**

```ts
it("defaults sandbox.workspaceProvider to host", async () => {
  const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
  await writeFile(
    p,
    JSON.stringify({
      orchestrator_url: "ws://localhost:3000/ws/agent",
      heartbeat_seconds: 30,
      mock_mode: true,
      agent_command: ["node", "--version"],
      agent: { id: "codex-local-1", max_concurrent: 2 },
      sandbox: { provider: "boxlite_oci", image: "alpine:latest" },
    }),
    "utf8",
  );
  const cfg = await loadConfig(p);
  expect(cfg.sandbox.workspaceProvider).toBe("host");
});

it("parses sandbox.workspaceProvider=guest", async () => {
  const p = path.join(tmpdir(), `acp-proxy-config-${Date.now()}-${Math.random()}.json`);
  await writeFile(
    p,
    JSON.stringify({
      orchestrator_url: "ws://localhost:3000/ws/agent",
      heartbeat_seconds: 30,
      mock_mode: true,
      agent_command: ["node", "--version"],
      agent: { id: "codex-local-1", max_concurrent: 2 },
      sandbox: { provider: "boxlite_oci", image: "alpine:latest", workspaceProvider: "guest" },
    }),
    "utf8",
  );
  const cfg = await loadConfig(p);
  expect(cfg.sandbox.workspaceProvider).toBe("guest");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "workspaceProvider"`
Expected: FAIL with “workspaceProvider is undefined” or schema warning.

**Step 3: Write minimal implementation**

```ts
// SandboxConfig
workspaceProvider: "host" | "guest";

// convict schema
workspaceProvider: {
  doc: "Workspace provider (host or guest)",
  format: ["host", "guest"],
  default: "host",
  env: "ACP_PROXY_SANDBOX_WORKSPACE_PROVIDER",
},
```

Also remove:
- `sandbox.workspaceMode`
- `sandbox.workspaceCheckout`
- `ACP_PROXY_SANDBOX_WORKSPACE_MODE`
- `ACP_PROXY_SANDBOX_WORKSPACE_CHECKOUT`

Update allowlist in `acp-proxy/src/config.ts`:
- remove `TUIXIU_SKIP_WORKSPACE_INIT`
- add `TUIXIU_WORKSPACE_PROVIDER`
- keep `TUIXIU_WORKSPACE_MODE` (语义改为 worktree/clone)

Update templates and README to only mention:
- `sandbox.workspaceProvider`（host/guest）
- `TUIXIU_WORKSPACE_MODE`（worktree/clone）

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "workspaceProvider"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/config.ts acp-proxy/src/config.test.ts acp-proxy/config.toml.example acp-proxy/config-local.toml acp-proxy/config-compose.toml acp-proxy/config-docker.toml acp-proxy/README.md
git commit -m "feat(acp-proxy): add workspace provider config"
```

---

### Task 2: acp-proxy 运行逻辑改为 provider + mode

**Files:**
- Modify: `acp-proxy/src/runs/workspacePath.ts`
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/runs/runTypes.ts`
- Modify: `acp-proxy/src/runs/agent.ts`
- Modify: `acp-proxy/src/runs/init.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Modify: `acp-proxy/src/workspace/workspaceInventory.ts`
- Modify: `acp-proxy/src/types.ts`
- Test: `acp-proxy/src/runs/runRuntime.test.ts`
- Test: `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

```ts
it("ensureHostWorkspaceGit uses worktree when provider=host and mode=worktree", async () => {
  const { ensureHostWorkspaceGit } = await import("./runRuntime.js");
  const { execFile } = await import("node:child_process");

  const ctx: any = {
    cfg: { sandbox: { workspaceProvider: "host", workspaceHostRoot: "C:/ws" } },
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

  const ctx: any = {
    cfg: { sandbox: { workspaceProvider: "host", workspaceHostRoot: "C:/ws" } },
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
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "ensureHostWorkspaceGit"`
Expected: FAIL (provider/mode 未生效)

**Step 3: Write minimal implementation**

- `defaultCwdForRun({ workspaceProvider, runId })`：`guest` → `/workspace/run-<runId>`，`host` → `/workspace`
- `ensureRuntime`：仅当 provider=host 才要求 `workspaceHostRoot` 并建立 `hostWorkspacePath`
- `ensureHostWorkspaceGit`：
  - provider !== host → return
  - mode = `TUIXIU_WORKSPACE_MODE`（默认 `worktree`）
  - worktree → repo cache + worktree add
  - clone → 原 clone/checkout 逻辑
- `handleSandboxControl remove_workspace`：不再读取 `workspace_mode`，改用 provider 决定删除 host/guest workspace
- `workspaceInventory` 与 `types.ts`：移除 `workspace_mode` 字段，改为 `workspace_provider`（如需上报）

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "ensureHostWorkspaceGit"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/runs/workspacePath.ts acp-proxy/src/runs/runRuntime.ts acp-proxy/src/runs/runTypes.ts acp-proxy/src/runs/agent.ts acp-proxy/src/runs/init.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/workspace/workspaceInventory.ts acp-proxy/src/types.ts acp-proxy/src/runs/runRuntime.test.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "refactor(acp-proxy): switch to workspace provider + mode"
```

---

### Task 3: acp-proxy 能力上报改为 workspaceProvider

**Files:**
- Modify: `acp-proxy/src/runProxyCli.ts`
- Test: `acp-proxy/src/runProxyCli.test.ts`

**Step 1: Write the failing test**

```ts
expect(registerPayload.agent.capabilities.sandbox.workspaceProvider).toBe("host");
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "workspaceProvider"`
Expected: FAIL (capabilities 未包含 workspaceProvider)

**Step 3: Write minimal implementation**

```ts
sandboxCaps.workspaceProvider = cfg.sandbox.workspaceProvider ?? "host";
```

Remove旧的 `sandbox.workspaceMode`。

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "workspaceProvider"`
Expected: PASS

**Step 5: Commit**

```bash
git add acp-proxy/src/runProxyCli.ts acp-proxy/src/runProxyCli.test.ts
git commit -m "feat(acp-proxy): report workspace provider capability"
```

---

### Task 4: 后端 sandbox capabilities & env 统一

**Files:**
- Modify: `backend/src/utils/sandboxCaps.ts`
- Modify: `backend/src/utils/workspacePolicy.ts`
- Modify: `backend/src/utils/agentWorkspaceCwd.ts`
- Modify: `backend/src/executors/acpAgentExecutor.ts`
- Modify: `backend/src/modules/runs/startIssueRun.ts`
- Modify: `backend/src/modules/runs/runRecovery.ts`
- Modify: `backend/.env.example`
- Test: `backend/test/utils/sandboxCaps.test.ts`
- Test: `backend/test/utils/workspacePolicy.test.ts`
- Test: `backend/test/executors/acpAgentExecutor.test.ts`
- Test: `backend/test/modules/runs/startIssueRun.test.ts`
- Test: `backend/test/modules/runs/runRecovery.test.ts`

**Step 1: Write the failing test**

```ts
expect(getSandboxWorkspaceProvider({ sandbox: { workspaceProvider: "guest" } })).toBe("guest");
expect(resolveAgentWorkspaceCwd({ runId: "r1", sandboxWorkspaceProvider: "guest" })).toBe("/workspace/run-r1");
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "workspaceProvider"`
Expected: FAIL (旧的 workspaceMode 解析)

**Step 3: Write minimal implementation**

- `sandboxCaps.ts`：新增 `SandboxWorkspaceProvider = "host" | "guest"` + `getSandboxWorkspaceProvider`
- `workspacePolicy.ts`：
  - policy=mount → provider 必须 host
  - policy=git → provider 必须 guest
- `agentWorkspaceCwd.ts`：根据 provider 选择 `/workspace` 或 `/workspace/run-<id>`
- `acpAgentExecutor.ts` / `startIssueRun.ts` / `runRecovery.ts`：
  - `initEnv.TUIXIU_WORKSPACE_PROVIDER = sandboxWorkspaceProvider`
  - `initEnv.TUIXIU_WORKSPACE_MODE = workspaceMode (worktree|clone)`
  - 若 provider=guest 且 mode=worktree → 将 mode 强制为 clone
  - 移除 `TUIXIU_SKIP_WORKSPACE_INIT`
- `workspacePolicy` 默认值不再读取 `WORKSPACE_POLICY_DEFAULT`，删除 `backend/.env.example` 中该 env 配置项
- 更新测试用例：capabilities 字段从 `workspaceMode: "git_clone"` 改为 `workspaceProvider: "guest"`；断言 env 与 provider/mode

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "workspaceProvider"`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/utils/sandboxCaps.ts backend/src/utils/workspacePolicy.ts backend/src/utils/agentWorkspaceCwd.ts backend/src/executors/acpAgentExecutor.ts backend/src/modules/runs/startIssueRun.ts backend/src/modules/runs/runRecovery.ts backend/test/utils/sandboxCaps.test.ts backend/test/utils/workspacePolicy.test.ts backend/test/executors/acpAgentExecutor.test.ts backend/test/modules/runs/startIssueRun.test.ts backend/test/modules/runs/runRecovery.test.ts
git commit -m "refactor(backend): unify workspace provider + mode"
```

---

### Task 5: 更新 init 脚本变量（移除 SKIP）

**Files:**
- Modify: `backend/src/utils/agentInit.ts`
- Test: `backend/test/utils/agentInit.test.ts`

**Step 1: Write the failing test**

```ts
expect(script).toContain("TUIXIU_WORKSPACE_PROVIDER");
expect(script).not.toContain("TUIXIU_SKIP_WORKSPACE_INIT");
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "agentInit"`
Expected: FAIL

**Step 3: Write minimal implementation**

- 替换脚本变量：
  - `workspace_provider="${TUIXIU_WORKSPACE_PROVIDER:-}"`
  - 删除 `skip_workspace_init`
- 跳过 guest init 的判断改为：
  - `if [ "$workspace_provider" = "host" ]; then ... exit 0; fi`
- 保留 `workspace_mode` 变量（worktree/clone）仅用于将来扩展（可先不使用）。

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "agentInit"`
Expected: PASS

**Step 5: Commit**

```bash
git add backend/src/utils/agentInit.ts backend/test/utils/agentInit.test.ts
git commit -m "refactor(backend): init script uses workspace provider"
```

---

### Task 6: 文档与协议字段清理

**Files:**
- Modify: `docs/01_architecture/acp-integration.md`
- Modify: `docs/03_guides/environment-setup.md`
- Modify: `docs/03_guides/quick-start.md` (如涉及旧字段)
- Modify: `acp-proxy/README.md` (已改则补充)

**Step 1: 更新文档说明**

- 统一术语：
  - `workspaceMode = worktree|clone`（策略）
  - `workspaceProvider = host|guest`（执行位置）
- 移除 `mount/git_clone` 与 `workspaceCheckout` 相关描述。

**Step 2: Commit**

```bash
git add docs/01_architecture/acp-integration.md docs/03_guides/environment-setup.md docs/03_guides/quick-start.md acp-proxy/README.md
git commit -m "docs: unify workspace provider + mode"
```

---

## Notes / Assumptions

- 不做兼容：旧字段与旧 env 全部移除。
- guest + worktree 视为 clone（后端在下发 env 时归一化，proxy 侧也不特殊处理）。
- `workspacePolicy=git` 仅允许 guest provider；`workspacePolicy=mount` 仅允许 host provider。

---

Plan complete and saved to `docs/plans/2026-02-04-workspace-provider-unification.md`. Two execution options:

1. Subagent-Driven (this session) - I dispatch fresh subagent per task, review between tasks, fast iteration
2. Parallel Session (separate) - Open new session with executing-plans, batch execution with checkpoints

Which approach?
