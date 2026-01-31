---
title: "ACP Platform Evolution Implementation Plan"
owner: "@yoke233"
status: "archived"
last_reviewed: "2026-01-31"
---

# ACP Platform Evolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `acp-proxy` 在 Windows / Linux / macOS 都能作为“一等公民”稳定运行，并具备可观测、可清理、可回收的实例/工作区管理能力（含遗留资源管理与真正的删除+上报），同时尽量减少用户需要填写的配置项。

**Architecture:** 把现有 `host_process/container_oci/boxlite_oci` 的分叉收敛到一个 `platform` 层（路径方言、init 执行、session 策略、workspace 语义），并引入 `inventory + reconciler + workspace manager` 作为资源管理核心；后端提供统一的管理 API 与 Admin UI，支持列出/对账/GC/删除/追踪删除结果与历史事件。

**Tech Stack:** TypeScript (Node.js 20+ ESM), Vitest, Fastify, Prisma/Postgres, Vite+React, Docker/Podman/nerdctl, BoxLite (可选)

---

## 0. 总体原则与约束（先读）

- **配置尽量少**：默认开箱即用（至少只填 `orchestrator_url` + `OPENAI_API_KEY`）；其余尽量自动探测或落盘生成（例如 `agent.id`）。
- **“真正管理”定义**：
  - 能列出：当前正在运行、已停止但仍存在、预期存在但缺失（丢失）、不在预期列表但仍存在（遗留/orphan）、已被系统删除（deleted）。
  - 能删除：实例（container/box/host）、工作区目录（host/sandbox 内），并能**删除后上报**（让后端与 UI 可以显示“已删除”而不是“神秘消失”）。
- **安全优先**：GC 默认只操作 “managed 资源”（带 label/前缀/registry 标记）；所有 destructive 操作提供 `dry_run`；对路径删除必须做 root 约束（防止误删）。
- **渐进式演进**：先做 inventory/GC（立刻止血磁盘膨胀），再做 platform 抽象与配置简化（结构性改造）。

---

## 1. 里程碑（建议）

- **M1（止血版）**：支持 orphan/missing/deleted 的可见化；支持一键清理 orphan 实例 + 清理 host workspace；删除后上报。
- **M2（配置简化）**：`agent.id` 自动生成与落盘；`sandbox.provider/runtime/image` 默认值与自动探测；提供最小配置示例。
- **M3（平台统一）**：引入 `platform/` 层，把 `runRuntime`/`AcpClientFacade` 内 `provider === "host_process"` 分支迁出。
- **M4（更好的 git_clone）**：支持“共享环境（BoxLite shared box 等）下每个 Run 独立 workspace 子目录”，并支持 workspace GC，避免 clone 膨胀。
- **M5（产品化）**：Admin UI 完整管理（列表/筛选/批量 GC/确认/结果追踪），文档与 Runbook 完整。

---

## Phase A：Inventory + 删除上报（优先级最高）

### Task 1: 定义 sandbox_inventory 的“删除上报”扩展字段（契约先行）

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `backend/src/websocket/gateway.ts`
- Test: `backend/test/websocket/gateway.test.ts`

**Step 1: Write the failing test**

在 `backend/test/websocket/gateway.test.ts` 增加用例，验证 `deleted_instances` 会被 upsert 成 `status=missing` 且 `lastError="deleted"`（先用 `lastError` 表达，后续再加 `deletedAt` 字段）。

```ts
it("sandbox_inventory accepts deleted_instances and marks them as deleted/missing", async () => {
  const prisma = {
    agent: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
    run: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    sandboxInstance: { upsert: vi.fn().mockResolvedValue({}) },
  } as any;

  const gateway = createWebSocketGateway({ prisma });
  const agentSocket = new FakeSocket();
  gateway.__testing.handleAgentConnection(agentSocket as any, vi.fn());

  agentSocket.emit("message", Buffer.from(JSON.stringify({ type: "register_agent", agent: { id: "proxy-1", name: "codex-1" } })));
  await flushMicrotasks();

  agentSocket.emit("message", Buffer.from(JSON.stringify({
    type: "sandbox_inventory",
    inventory_id: "inv-3",
    captured_at: "2026-01-31T12:00:00.000Z",
    deleted_instances: [{ instance_name: "tuixiu-run-r3", run_id: "r3" }],
  })));
  await flushMicrotasks();
  await flushMicrotasks();

  expect(prisma.sandboxInstance.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        proxyId: "proxy-1",
        instanceName: "tuixiu-run-r3",
        runId: "r3",
        status: "missing",
        lastError: "deleted",
      }),
    }),
  );
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "deleted_instances"`
Expected: FAIL（gateway 未处理 `deleted_instances`）

**Step 3: Write minimal implementation**

1) 扩展 `acp-proxy/src/types.ts`：

```ts
export type SandboxControlMessage = {
  // ...
};

export type SandboxInventoryMessage = {
  type: "sandbox_inventory";
  inventory_id: string;
  captured_at?: string;
  provider?: string;
  runtime?: string;
  instances?: Array<{ /* existing */ }>;
  missing_instances?: Array<{ instance_name: string; run_id?: string | null }>;
  deleted_instances?: Array<{ instance_name: string; run_id?: string | null; deleted_at?: string; reason?: string }>;
};
```

（如果当前没有 `SandboxInventoryMessage` 类型，就先只在 `IncomingMessage`/后端侧按 `unknown` 处理，后续再补齐类型。）

2) 在 `backend/src/websocket/gateway.ts` 的 `message.type === "sandbox_inventory"` 分支里，新增处理：

```ts
const deletedInstances = Array.isArray((message as any).deleted_instances) ? (message as any).deleted_instances : [];
for (const inst of deletedInstances) {
  // upsert: status=missing, lastError="deleted", lastSeenAt=capturedAt
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "deleted_instances"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/websocket/gateway.ts backend/test/websocket/gateway.test.ts acp-proxy/src/types.ts
git commit -m "feat(acp): report deleted instances via sandbox_inventory"
```

---

### Task 2: acp-proxy 在 remove/stop/GC 后主动上报 deleted_instances（形成闭环）

**Files:**
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/handlers/handlers.test.ts` 或新建 `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

新增测试：当收到 `sandbox_control { action: "remove" }` 且 sandbox.removeInstance 成功时，proxy 会发送一条 `sandbox_inventory`，包含 `deleted_instances`，并且 `sandbox_control_result.ok=true`。

（建议新建 `acp-proxy/src/handlers/handleSandboxControl.test.ts`，复用 `handlers.test.ts` 的 harness 思路，构造 `ctx.send` 收集消息。）

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "deleted_instances"`
Expected: FAIL（当前 remove 不会额外发 inventory）

**Step 3: Write minimal implementation**

在 `handleSandboxControl.ts` 的 `action === "remove"` 分支里，remove 成功后：

```ts
await ctx.sandbox.removeInstance(instanceName);
await reportInventory(ctx);
ctx.send({
  type: "sandbox_inventory",
  inventory_id: randomUUID(),
  captured_at: nowIso(),
  provider: ctx.sandbox.provider,
  runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
  deleted_instances: [{ instance_name: instanceName, run_id: runId || null, reason: "sandbox_control_remove" }],
});
```

（后续再优化：避免重复发两条 inventory；可合并为一次 payload。先用最小实现跑通链路。）

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "deleted_instances"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "feat(acp-proxy): emit deleted_instances after sandbox remove"
```

---

### Task 3: 增加“遗留/orphan”视角：后端按 expected 实例列表对账并标注 orphan

**Files:**
- Modify: `backend/src/routes/sandboxes.ts`
- Modify: `backend/test/routes/sandboxes.test.ts`
- Optional Modify: `backend/src/websocket/gateway.ts`

**Step 1: Write the failing test**

给 `POST /api/admin/sandboxes/control` 增加新 action `prune_orphans`，并验证会向 proxy 发送 `sandbox_control`：

```ts
it("POST /api/admin/sandboxes/control supports prune_orphans by proxyId", async () => {
  // prisma.sandboxInstance.findMany -> expected list
  // sendToAgent called with { action:"prune_orphans", expected_instances:[...] }
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "prune_orphans"`
Expected: FAIL（zod enum 不包含该 action）

**Step 3: Write minimal implementation**

1) `backend/src/routes/sandboxes.ts`：
  - 扩展 action 枚举：`"prune_orphans"`（并要求提供 `proxyId`）
  - 从 `sandboxInstance` 取 expected（已存在逻辑，可复用 `report_inventory` 的 expected 查询）
  - sendToAgent payload：

```ts
await deps.sendToAgent(body.proxyId, {
  type: "sandbox_control",
  action: "prune_orphans",
  expected_instances: expected.map((item) => ({ instance_name: item.instanceName, run_id: item.runId ?? null })),
});
```

2) 先不改 `gateway.ts`，由 proxy 侧执行 prune 并通过 `deleted_instances` 上报。

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "prune_orphans"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/routes/sandboxes.ts backend/test/routes/sandboxes.test.ts
git commit -m "feat(backend): add prune_orphans sandbox control action"
```

---

### Task 4: acp-proxy 实现 prune_orphans（只清理 managed 且不在 expected 列表中的实例）

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

测试：给定 `listInstances()` 返回 `["tuixiu-run-a","tuixiu-run-b"]`，expected 仅包含 `tuixiu-run-a`，执行 `prune_orphans` 后应调用 `removeInstance("tuixiu-run-b")`，并发送 `sandbox_inventory.deleted_instances` 包含 b。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "prune_orphans"`
Expected: FAIL

**Step 3: Write minimal implementation**

在 `acp-proxy/src/types.ts` 增加 action：

```ts
action:
  | "inspect"
  | "ensure_running"
  | "stop"
  | "remove"
  | "report_inventory"
  | "remove_image"
  | "git_push"
  | "prune_orphans";
```

在 `handleSandboxControl.ts` 中实现：
- 读取 `expected_instances`
- `known = await ctx.sandbox.listInstances({ managedOnly: true })`
- `orphans = known.filter(x => !expectedSet.has(x.instanceName))`
- 逐个 `stop + remove`（或直接 remove，按 provider 能力决定）
- 汇总 `deleted_instances` 并上报一条 inventory

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "prune_orphans"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/types.ts acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "feat(acp-proxy): prune orphan sandbox instances"
```

---

### Task 4.1: 后端支持 gc（可 dry_run，可带 expected_instances 做对账）

**Files:**
- Modify: `backend/src/routes/sandboxes.ts`
- Modify: `backend/test/routes/sandboxes.test.ts`

**Step 1: Write the failing test**

新增用例：`POST /api/admin/sandboxes/control` 支持 `action="gc"`，并会向 proxy 下发：
- `action: "gc"`
- `request_id`
- `expected_instances`（用于判定 orphan/missing）
- `dry_run`（默认 true，避免误删）

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "action=gc"`
Expected: FAIL

**Step 3: Write minimal implementation**

在 `backend/src/routes/sandboxes.ts`：
- action enum 增加 `"gc"`
- `gc` 要求 `proxyId`（与 `report_inventory` 同类）
- payload 增加 `dry_run: true`（后续 UI 再提供切换）

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "action=gc"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/routes/sandboxes.ts backend/test/routes/sandboxes.test.ts
git commit -m "feat(backend): add gc sandbox control action"
```

---

### Task 4.2: acp-proxy 实现 gc（组合 prune_orphans + remove_workspace，支持 dry_run）

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

用例 1（dry_run）：给定 known 实例 2 个、expected 1 个，`action=gc,dry_run=true` 返回 `ok=true`，并在结果里包含 `planned.deletes` 数组。

用例 2（apply）：`dry_run=false` 会实际调用 `removeInstance`（对 orphan）+ `remove_workspace`（按 workspaceMode）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "action=gc"`
Expected: FAIL

**Step 3: Write minimal implementation**

1) `acp-proxy/src/types.ts` 增加 action 与参数：

```ts
action:
  | /* existing */
  | "gc";

dry_run?: boolean;
gc?: {
  remove_orphans?: boolean;
  remove_workspaces?: boolean;
  max_delete_count?: number;
};
```

2) `handleSandboxControl.ts` 新增分支：
- 解析 `dry_run`（默认 true）
- 解析 expected_instances
- 计算 `orphans`
- 生成计划：`{ delete_instances: [...], delete_workspaces: [...] }`
- dry_run：`reply({ ok:true, planned })`
- apply：
  - 依次执行删除（注意 try/catch 记录失败原因）
  - 发送 `sandbox_inventory.deleted_instances`（以及后续可加入 `deleted_workspaces`）
  - 最后 `reportInventory(ctx, expected)` 让后端刷新状态

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "action=gc"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/types.ts acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "feat(acp-proxy): implement gc sandbox control action"
```

---

## Phase B：Workspace 管理 + GC（解决 clone 膨胀）

### Task 5: 增加 workspace_control（删除 host workspace / 删除 sandbox 内 workspace）

**Files:**
- Modify: `acp-proxy/src/types.ts`
- Modify: `backend/src/routes/sandboxes.ts`
- Modify: `backend/test/routes/sandboxes.test.ts`
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

后端：`action="remove_workspace"` 时可按 `runId` 或 `instanceName+proxyId` 下发，并携带 `run_id` 与 `workspace_mode`（可选）。

proxy：收到 `remove_workspace` 后，在 `workspaceMode=mount` 时删除 `workspaceHostRoot/run-<runId>`；在 `git_clone` 时执行 `rm -rf /workspace`（先做最简单版本，后续再做 per-run 子目录）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "remove_workspace"`
Run: `pnpm -C acp-proxy test -- -t "remove_workspace"`
Expected: FAIL

**Step 3: Write minimal implementation**

1) `acp-proxy/src/types.ts` 加入 action：`"remove_workspace"`
2) `backend/src/routes/sandboxes.ts` action enum 加入 `remove_workspace`
3) `acp-proxy/src/handlers/handleSandboxControl.ts` 新分支：
  - `workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount"`
  - mount：用 Node `rm(hostWorkspacePath,{recursive:true,force:true})`，并确保路径在 `workspaceHostRoot` 下
  - git_clone：`ctx.sandbox.execProcess({ command:["bash","-lc","rm -rf /workspace/*"], ... })`（后续会升级为 per-run path）
  - 成功后发送 `sandbox_inventory` with `deleted_workspaces`（需要定义字段；或先复用 `agent_update`/event，MVP 先不存 DB）

**Step 4: Run tests to verify they pass**

Run: `pnpm -C backend test -- -t "remove_workspace"`
Run: `pnpm -C acp-proxy test -- -t "remove_workspace"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/routes/sandboxes.ts backend/test/routes/sandboxes.test.ts acp-proxy/src/types.ts acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "feat: add remove_workspace sandbox control action"
```

---

### Task 6: 为 clone 膨胀做“更正确”的设计：引入 per-run workspace 子目录（/workspace/run-<runId>）

**Files:**
- Modify: `acp-proxy/src/proxyContext.ts`（如需）
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Modify: `acp-proxy/src/handlers/handleAcpOpen.ts`
- Modify: `docs/01_architecture/acp-integration.md`
- Test: `acp-proxy/src/runs/hostCwd.test.ts`（或新建 `workspacePath.test.ts`）

**Step 1: Write the failing test**

新增测试：当 `workspaceMode=git_clone` 且 `run_id=r1` 且未指定 `cwd` 时，proxy 应对 agent 使用 `cwd=/workspace/run-r1`（而不是 `/workspace`）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "workspace/run-"`
Expected: FAIL（当前默认 `/workspace`）

**Step 3: Write minimal implementation**

新增一个纯函数（建议新文件）：

```ts
export function defaultCwdForRun(opts: { workspaceMode: "mount" | "git_clone"; runId: string }): string {
  if (opts.workspaceMode === "git_clone") return `/workspace/run-${opts.runId}`;
  return "/workspace";
}
```

在 `handleAcpOpen` / `handlePromptSend`：
- `cwd = msg.cwd ?? defaultCwdForRun({ workspaceMode, runId })`
- git_clone init/脚本也应 clone 到该目录（见后续 Task 7）

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "workspace/run-"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/runs/runRuntime.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/handlers/handleAcpOpen.ts acp-proxy/src/runs/workspacePath.ts acp-proxy/src/runs/workspacePath.test.ts docs/01_architecture/acp-integration.md
git commit -m "feat(acp-proxy): use per-run workspace subdir for git_clone"
```

---

### Task 7: 为 per-run workspace 子目录补齐 init 约定（git clone 到 /workspace/run-<runId>）

**Files:**
- Modify: `backend/src/modules/runs/runRecovery.ts`（若 init 由后端生成）
- Modify: `backend/src/modules/runs/runContext.ts`（若需要）
- Modify: `docs/03_guides/environment-setup.md`
- Test: `backend/test/...`（补一条生成 init 的用例，按实际位置）

**Step 1: Write the failing test**

新增用例：生成的 `acp_open.init.script` 包含 `ws=/workspace/run-<runId>` 并 `git clone ... "$ws"`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "workspace/run-"`
Expected: FAIL

**Step 3: Write minimal implementation**

把 init script 里写死的 `/workspace` 替换为 `TUIXIU_WORKSPACE_GUEST=/workspace/run-<runId>`（或同等变量），让 `git_clone` 一致落到 run 子目录。

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "workspace/run-"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/modules/runs/runRecovery.ts backend/test/... docs/03_guides/environment-setup.md
git commit -m "feat(backend): git_clone init clones into per-run workspace subdir"
```

---

### Task 7.1: 同步“用户可见 workspace 路径”：Run 提示与 acpSessions API 使用正确 cwd

**Files:**
- Modify: `backend/src/modules/runs/startIssueRun.ts`
- Modify: `backend/src/routes/acpSessions.ts`
- Test: `backend/test/routes/...`（按现有测试组织补最小用例）
- Docs: `docs/03_guides/quick-start.md`（如提到 workspace）

**Step 1: Write the failing test**

用例：当 Run 使用 `sandbox.workspaceMode=git_clone` 且启用 per-run 子目录时：
- `startIssueRun` 生成的提示里 `workspace: /workspace/run-<runId>`
- `POST /api/admin/acp-sessions/cancel|set-mode|set-model` 发送到 agent 的 `cwd` 也是该路径（或由 proxy 自动映射，但二者至少一致）

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "workspace/run-"`
Expected: FAIL（目前硬编码 `/workspace`）

**Step 3: Write minimal implementation**

新增一个 helper（建议新文件）：`backend/src/utils/agentWorkspaceCwd.ts`

```ts
export function resolveAgentWorkspaceCwd(opts: { runId: string; sandboxWorkspaceMode?: string | null }): string {
  return opts.sandboxWorkspaceMode === "git_clone" ? `/workspace/run-${opts.runId}` : "/workspace";
}
```

- `startIssueRun.ts` 用该函数替换 `agentWorkspacePath="/workspace"`
- `acpSessions.ts` 使用该函数替换传给 `deps.acp.*` 的 `cwd`

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "workspace/run-"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/modules/runs/startIssueRun.ts backend/src/routes/acpSessions.ts backend/src/utils/agentWorkspaceCwd.ts backend/test/... docs/03_guides/quick-start.md
git commit -m "feat(backend): use per-run guest cwd for git_clone"
```

---

### Task 8: 升级 remove_workspace：在 git_clone 下仅删除 /workspace/run-<runId>（不再粗暴清空 /workspace）

**Files:**
- Modify: `acp-proxy/src/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/handlers/handleSandboxControl.test.ts`

**Step 1: Write the failing test**

当 `workspaceMode=git_clone` 且 `run_id=r1`，`remove_workspace` 应执行 `rm -rf /workspace/run-r1`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "rm -rf /workspace/run-r1"`
Expected: FAIL

**Step 3: Write minimal implementation**

```ts
const guestWs = `/workspace/run-${effectiveRunId}`;
await ctx.sandbox.execProcess({
  instanceName,
  command: ["bash", "-lc", `rm -rf '${guestWs.replaceAll("'", "'\\''")}'`],
  cwdInGuest: "/workspace",
});
```

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "rm -rf /workspace/run-r1"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/handlers/handleSandboxControl.ts acp-proxy/src/handlers/handleSandboxControl.test.ts
git commit -m "feat(acp-proxy): remove_workspace deletes per-run git_clone dir"
```

---

## Phase C：配置最小化（减少用户心智负担）

### Task 9: agent.id 自动生成与落盘（用户不必填 agent.id）

**Files:**
- Create: `acp-proxy/src/identity/agentIdentity.ts`
- Modify: `acp-proxy/src/config.ts`
- Test: `acp-proxy/src/config.test.ts`
- Docs: `acp-proxy/config.toml.example`

**Step 1: Write the failing test**

在 `acp-proxy/src/config.test.ts` 增加用例：当配置里不提供 `agent.id` 时，`loadConfig()` 仍可成功，并返回 `agent.id` 非空且稳定（同一路径重复 load 一致）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "agent.id auto"`
Expected: FAIL（convict schema 要求 non-empty-string）

**Step 3: Write minimal implementation**

实现 `agentIdentity.ts`（落盘在 `~/.tuixiu/acp-proxy/identity.json`，允许通过 env 覆盖）：

```ts
export async function loadOrCreateAgentId(): Promise<string> {
  // 1) if env ACP_PROXY_AGENT_ID present -> return
  // 2) else read identity.json -> return stored id
  // 3) else generate from hostname + randomUUID, write file, return
}
```

在 `config.ts`：
- 允许 `agent.id` 为空（schema 放宽）
- `loadConfig()` 末尾：若 `effective.agent.id` 为空，调用 `loadOrCreateAgentId()` 填充
- 同步更新 `agent.name` 默认逻辑

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "agent.id auto"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/identity/agentIdentity.ts acp-proxy/src/config.ts acp-proxy/src/config.test.ts acp-proxy/config.toml.example
git commit -m "feat(acp-proxy): auto-generate and persist agent.id"
```

---

### Task 10: sandbox.runtime / sandbox.image 自动探测与默认值（进一步减少必填项）

**Files:**
- Modify: `acp-proxy/src/config.ts`
- Test: `acp-proxy/src/config.test.ts`
- Docs: `acp-proxy/config.toml.example`

**Step 1: Write the failing test**

新增用例：当 `provider=container_oci` 且未提供 `runtime` 时，`loadConfig()` 自动选择 `docker`（或按优先级探测到的 runtime）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "auto-detect runtime"`
Expected: FAIL（目前硬性要求 runtime）

**Step 3: Write minimal implementation**

在 `config.ts`：
- 去掉 `provider=container_oci 必须配置 runtime` 的硬失败，改为：
  - 若 runtime 为空：尝试探测 `docker`/`podman`/`nerdctl`（只做 `spawn` 探测版本或 `--version`）
  - 探测不到再抛错（错误信息明确告诉用户如何配置）
- `image` 也提供默认（例如 `tuixiu-codex-acp:local`），若 pull/build 失败由运行时错误提示引导用户

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "auto-detect runtime"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/config.ts acp-proxy/src/config.test.ts acp-proxy/config.toml.example
git commit -m "feat(acp-proxy): auto-detect container runtime and default image"
```

---

## Phase D：平台统一（把分叉收敛到 platform 层）

### Task 11: 引入 platform 接口（只创建骨架与最小实现）

**Files:**
- Create: `acp-proxy/src/platform/types.ts`
- Create: `acp-proxy/src/platform/createPlatform.ts`
- Create: `acp-proxy/src/platform/native/nativePlatform.ts`
- Create: `acp-proxy/src/platform/container/containerPlatform.ts`
- Create: `acp-proxy/src/platform/boxlite/boxlitePlatform.ts`
- Test: `acp-proxy/src/platform/createPlatform.test.ts`

**Step 1: Write the failing test**

测试：`createPlatform()` 在 `provider=host_process` 返回 `NativePlatform`，在 `container_oci` 返回 `ContainerPlatform`，否则 `BoxlitePlatform`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "createPlatform"`
Expected: FAIL（文件不存在）

**Step 3: Write minimal implementation**

`platform/types.ts`：

```ts
export interface RunPlatform {
  readonly kind: "native" | "container" | "boxlite";
  resolveCwdForAgent(opts: { cwd: string; runHostWorkspacePath?: string | null }): string;
}
```

`createPlatform.ts`：按 cfg 选择实现（先最小）。

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "createPlatform"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/platform
git commit -m "feat(acp-proxy): introduce platform abstraction skeleton"
```

---

### Task 12: 迁移 cwd 映射：把 host_process 的 mapCwdForHostProcess 收进 platform

**Files:**
- Modify: `acp-proxy/src/runs/hostCwd.ts`
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/handlers/handlePromptSend.ts`
- Test: `acp-proxy/src/runs/hostCwd.test.ts`

**Step 1: Write the failing test**

新增测试：`NativePlatform.resolveCwdForAgent()` 行为与 `mapCwdForHostProcess()` 一致（Windows 与 POSIX 各一条）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "NativePlatform.resolveCwdForAgent"`
Expected: FAIL

**Step 3: Write minimal implementation**

- 在 `NativePlatform` 内部调用 `mapCwdForHostProcess`（或把纯函数移动到 `platform/path`，让 `runs` 不再关心 provider）
- `runRuntime.ts` 与 `handlePromptSend.ts` 改为使用 `ctx.platform.resolveCwdForAgent(...)`

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "NativePlatform.resolveCwdForAgent"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/runs/runRuntime.ts acp-proxy/src/handlers/handlePromptSend.ts acp-proxy/src/platform/native/nativePlatform.ts acp-proxy/src/runs/hostCwd.test.ts
git commit -m "refactor(acp-proxy): move host cwd mapping into platform"
```

---

### Task 13: 迁移 session 默认策略：把 host 下 mode=auto 逻辑从 runRuntime 移到 platform

**Files:**
- Modify: `acp-proxy/src/runs/runRuntime.ts`
- Modify: `acp-proxy/src/platform/types.ts`
- Modify: `acp-proxy/src/platform/native/nativePlatform.ts`
- Test: `acp-proxy/src/runs/runRuntime.test.ts`（如无则新建最小用例）

**Step 1: Write the failing test**

构造一个 fake agent：`session/new` 返回 `configOptions` 含 mode=auto + currentValue!=auto，验证会调用 `session/set_config_option`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "mode=auto"`
Expected: FAIL（还在旧位置或未抽象）

**Step 3: Write minimal implementation**

在 `RunPlatform` 增加 hook：

```ts
onSessionCreated?: (opts: { run: RunRuntime; sessionId: string; createdMeta: unknown }) => Promise<void>;
```

把 `ensureSessionForPrompt` 里 host_process 的 mode=auto 逻辑搬到 `NativePlatform.onSessionCreated`，`ensureSessionForPrompt` 只负责调用 hook。

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "mode=auto"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/runs/runRuntime.ts acp-proxy/src/platform/types.ts acp-proxy/src/platform/native/nativePlatform.ts acp-proxy/src/runs/runRuntime.test.ts
git commit -m "refactor(acp-proxy): move session policy into platform"
```

---

## Phase E：后端与 UI 体验完善（可操作、可追踪）

### Task 14: 扩展 Admin API：增加批量 GC/删除，并返回 request_id 供追踪

**Files:**
- Modify: `backend/src/routes/sandboxes.ts`
- Modify: `backend/test/routes/sandboxes.test.ts`
- Optional Modify: `backend/src/modules/sandbox/sandboxControl.ts`

**Step 1: Write the failing test**

新增用例：`POST /api/admin/sandboxes/control` action=prune_orphans/remove_workspace/gc 会返回 `requestId`（UUIDv7），并把它下发到 proxy（payload.request_id）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "requestId"`
Expected: FAIL

**Step 3: Write minimal implementation**

- 在 route 中生成 `request_id = uuidv7()` 并带到 sendToAgent payload
- route 返回 `{ success:true, data:{ ok:true, requestId } }`

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "requestId"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/src/routes/sandboxes.ts backend/test/routes/sandboxes.test.ts
git commit -m "feat(backend): return requestId for sandbox control actions"
```

---

### Task 15: 前端 Admin UI：增加 orphan/missing/deleted 筛选与操作入口（最小可用）

**Files:**
- Modify: `frontend/src/pages/admin/sections/AcpSessionsSection.tsx`
- Modify: `frontend/src/pages/admin/AdminPage.tsx`（如需要）
- Test: `frontend/src/...`（按现有测试结构补最小用例；如无则先不加）

**Step 1: Write the failing test**

（若前端已有 Testing Library 配置）新增用例：点击 “Prune Orphans” 会调用 `/api/admin/sandboxes/control` 并带 `action=prune_orphans`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C frontend test -- -t "Prune Orphans"`
Expected: FAIL

**Step 3: Write minimal implementation**

- 在 “ACP Proxies / Sessions” 区域增加按钮：
  - `Report Inventory`
  - `Prune Orphans`
  - `Remove Workspace`
- 操作后 toast/alert 显示 `requestId`，并提示用户刷新/等待 inventory 更新

**Step 4: Run test to verify it passes**

Run: `pnpm -C frontend test -- -t "Prune Orphans"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add frontend/src/pages/admin/sections/AcpSessionsSection.tsx frontend/src/pages/admin/AdminPage.tsx
git commit -m "feat(frontend): add sandbox prune/remove controls to admin UI"
```

---

## Phase F：更进一步（可选增强，按需排期）

### Task 16 (Optional): Workspace inventory（列出/估算大小/删除后上报）

**Files:**
- Create: `acp-proxy/src/workspace/workspaceInventory.ts`
- Modify: `acp-proxy/src/runProxyCli.ts`
- Modify: `backend/src/websocket/gateway.ts`
- Optional Create: `backend/prisma/schema.prisma` 新 model `WorkspaceInstance`
- Optional Modify: `frontend/src/pages/admin/sections/AcpSessionsSection.tsx`

**Step 1: Write the failing test**

后端 gateway 新增用例：收到 `workspace_inventory` 会 upsert workspace（或至少广播到 clients）。

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "workspace_inventory"`
Expected: FAIL

**Step 3: Write minimal implementation**

- proxy 连接成功后发送一次 `workspace_inventory`：
  - mount：扫描 `workspaceHostRoot/run-*`，输出 `exists/mtime/sizeBytes?`
  - git_clone：若支持 per-run 子目录，列出 `/workspace/run-*`（通过 `bash -lc` + `ls` 或 `find`）
- backend gateway：新增 `message.type === "workspace_inventory"` 分支（先广播；后续再落库）

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "workspace_inventory"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/workspace/workspaceInventory.ts acp-proxy/src/runProxyCli.ts backend/src/websocket/gateway.ts backend/test/websocket/gateway.test.ts
git commit -m "feat: add workspace inventory reporting"
```

---

### Task 17 (Optional): 为 SandboxInstance 增加 deletedAt / orphanedAt 字段（区分“缺失”与“已删除”）

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<ts>/migration.sql`（由 Prisma 生成）
- Modify: `backend/src/websocket/gateway.ts`
- Test: `backend/test/websocket/gateway.test.ts`

**Step 1: Write the failing test**

更新 `deleted_instances` 用例：期待 upsert 时写入 `deletedAt`。

**Step 2: Run test to verify it fails**

Run: `pnpm -C backend test -- -t "deletedAt"`
Expected: FAIL

**Step 3: Write minimal implementation**

1) schema 增加字段：

```prisma
model SandboxInstance {
  // ...
  deletedAt DateTime?
  orphanedAt DateTime?
}
```

2) 生成迁移：`pnpm -C backend prisma:migrate`
3) gateway：当处理 `deleted_instances` 时设置 `deletedAt=now`

**Step 4: Run test to verify it passes**

Run: `pnpm -C backend test -- -t "deletedAt"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/websocket/gateway.ts backend/test/websocket/gateway.test.ts
git commit -m "feat(backend): persist deletedAt for sandbox instances"
```

---

### Task 18 (Optional): 周期性 inventory + 自动 GC（无需手动点按钮）

**Files:**
- Modify: `acp-proxy/src/runProxyCli.ts`
- Modify: `acp-proxy/src/config.ts`
- Docs: `acp-proxy/config.toml.example`

**Step 1: Write the failing test**

（可用 fake timers）验证：连接成功后每 N 秒自动上报 inventory。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "periodic inventory"`
Expected: FAIL

**Step 3: Write minimal implementation**

- 新增 config：`inventoryIntervalSeconds`（默认 300，允许 0 关闭）
- `onConnected` 后 `setInterval(reportInventory, ...)`
- GC 策略先不自动删除，默认只上报（安全）

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "periodic inventory"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/runProxyCli.ts acp-proxy/src/config.ts acp-proxy/config.toml.example
git commit -m "feat(acp-proxy): periodic sandbox inventory reporting"
```

---

### Task 19 (Optional): native(host) 进程 registry（可列出/可 kill，但不承诺 reattach）

**Files:**
- Modify: `acp-proxy/src/sandbox/hostProcessProxySandbox.ts`
- Create: `acp-proxy/src/sandbox/nativeRegistry.ts`
- Test: `acp-proxy/src/sandbox/nativeRegistry.test.ts`

**Step 1: Write the failing test**

测试：启动 agent 时写 registry（包含 pid、workspacePath、startedAt），`listInstances` 可从 registry 恢复。

**Step 2: Run test to verify it fails**

Run: `pnpm -C acp-proxy test -- -t "nativeRegistry"`
Expected: FAIL

**Step 3: Write minimal implementation**

- registry 存在 `workspaceHostRoot/.acp-proxy/registry.json`
- `openAgent` 写入 pid
- `removeInstance`：尝试 `process.kill(pid)`（跨平台注意 signal），再清理 registry

**Step 4: Run test to verify it passes**

Run: `pnpm -C acp-proxy test -- -t "nativeRegistry"`
Expected: PASS

**Step 5: Commit**

```pwsh
git add acp-proxy/src/sandbox/hostProcessProxySandbox.ts acp-proxy/src/sandbox/nativeRegistry.ts acp-proxy/src/sandbox/nativeRegistry.test.ts
git commit -m "feat(acp-proxy): persist native process registry for inventory/cleanup"
```

---

## 文档交付（不要省略）

- 更新 `docs/01_architecture/acp-integration.md`：补充 platform + inventory + workspace GC 的概念与消息形态
- 更新 `docs/03_guides/environment-setup.md`：给出“最小配置示例”（只填 2~3 项即可跑）
- 更新 `acp-proxy/README.md`：新增“如何清理 orphan 与 workspace”的 Runbook

---

## 计划执行建议

- 推荐先做 **Phase A + Phase B（Task 1~8）**：立刻解决“遗留实例/工作区膨胀”与“删除可追踪”
- 再做 **Phase C（Task 9~10）**：大幅减少配置痛点
- 最后做 **Phase D（Task 11~13）**：结构性收敛 provider 分叉，提升可维护性
