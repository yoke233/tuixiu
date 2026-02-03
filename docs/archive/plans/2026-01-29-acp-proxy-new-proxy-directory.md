---
title: "acp-proxy 新 `proxy/` 目录重写 Implementation Plan"
owner: "@yoke233"
status: "archived"
last_reviewed: "2026-01-28"
---

# acp-proxy 新 `proxy/` 目录重写 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 `acp-proxy/src/proxy/` 里重写并拆分 `proxyCli` 逻辑，保持对 orchestrator 的消息协议与现有 e2e 行为不变，同时引入一个抽象的“容器/沙箱运行时接口”，以便现在跑通 Docker（OCI CLI），后续低成本接入 Boxlite。

**Architecture:** 新增 `src/proxy/` 作为新的 SSOT（Single Source of Truth）。`src/proxyCli.ts` 暂时保留为兼容入口，但最终退化为 thin wrapper（只转调新实现）。沙箱侧通过 `ProxySandbox`（抽象接口）隔离“如何启动 ACP agent/如何 exec/如何管理实例”，Docker 使用 OCI CLI 实现，Boxlite 通过适配 `BoxliteSandbox` 实现（先占位/最小实现，后续再增强）。

**Tech Stack:** TypeScript (NodeNext/ESM), Vitest, `ws`, `@agentclientprotocol/sdk`，以及现有 `acp-proxy/src/sandbox/*`（`ContainerSandbox`/`BoxliteSandbox`/`cliRuntime`）。

---

## 0) 现状盘点：文件去留/过度封装/可删除项

### 0.1 必须保留（作为稳定边界/复用）

- 入口与配置
  - 保留：`acp-proxy/src/index.ts`（CLI 入口；后续可改为 import 新入口）
  - 保留：`acp-proxy/src/config.ts`、`acp-proxy/src/config.test.ts`（配置解析/约束）
  - 保留：`acp-proxy/src/logger.ts`
  - 保留：`acp-proxy/src/types.ts`（orchestrator ↔ proxy 的消息类型定义；新实现可复用/补齐）
- ACP 侧能力
  - 保留：`acp-proxy/src/acpClientFacade.ts`（terminal/exec JSON-RPC bridge；新实现继续使用）
- Sandbox/容器能力（复用，避免重复造轮子）
  - 保留：`acp-proxy/src/sandbox/types.ts`
  - 保留：`acp-proxy/src/sandbox/containerSandbox.ts`（实例 inspect/stop/remove/attach/exec/list）
  - 保留：`acp-proxy/src/sandbox/boxliteSandbox.ts`（Boxlite 现有实现，后续适配）
  - 保留：`acp-proxy/src/sandbox/cliRuntime.ts`（OCI CLI 通用 runner）

### 0.2 “过度封装/遗留”的候选（建议删或迁移为 docs/examples）

- 过度封装且当前无引用：
  - 候选删除：`acp-proxy/src/launchers/types.ts`
  - 候选删除：`acp-proxy/src/launchers/sandboxLauncher.ts`
- 示例/未接入生产链路（且容易误导维护者）：
  - 候选删除或迁移到 `docs/`：`acp-proxy/src/sandbox/containerOciGlue.ts`
- 与新模式重复、且当前无引用：
  - 候选删除：`acp-proxy/src/sandbox/providers/container_oci_cli.ts`

> 删除原则：必须先让 `pnpm -C acp-proxy test`、`pnpm -C acp-proxy test:docker` 通过；再 `rg -n` 全仓确认无引用后删除。

### 0.3 必须修改/重构的目标文件

- 必改：`acp-proxy/src/proxyCli.ts`
  - 目标：改成 thin wrapper，只负责解析 configPath/profile 并调用新入口 `acp-proxy/src/proxy/runProxyCli.ts`（或 `src/proxy/index.ts` 导出）。
- 新增（SSOT）：`acp-proxy/src/proxy/**`
  - 目标：把“WS 连接/心跳/消息处理/run 状态机/ACP 读写/容器抽象”全部迁移到这里。
- 测试需要增补：
  - 保留并确保通过：`acp-proxy/src/proxyCli.docker.e2e.test.ts`、`acp-proxy/test/proxyCli.oci-cli.e2e.test.ts`
  - 新增：`acp-proxy/src/proxy/**/*.test.ts`（不依赖 Docker 的单测，覆盖状态机与 ACP bridge）

---

## 1) 新目录设计（建议的模块划分）

目标：让每个模块只做一件事，减少 `proxyCli.ts` 这种 1k+ 行“上帝文件”复活。

- `acp-proxy/src/proxy/runProxyCli.ts`
  - 进程入口：加载 config → 创建 logger → 选择 sandbox adapter → 启动 orchestrator 连接 loop
- `acp-proxy/src/proxy/orchestrator/orchestratorClient.ts`
  - 连接/重连/心跳/消息分发（只做 IO，不做业务）
- `acp-proxy/src/proxy/runs/runManager.ts`
  - `Map<runId, RunRuntime>` 生命周期、TTL 清理、每 run 串行队列（opQueue）
- `acp-proxy/src/proxy/acp/agentBridge.ts`
  - 管理 ACP agent 的 NDJSON stream：读/写、pending RPC、init marker 解析、通知转发（acp_update）
- `acp-proxy/src/proxy/sandbox/ProxySandbox.ts`
  - 抽象接口：`openAgent`/`exec`/`inspect`/`stop`/`remove`/`list`（隐藏 Docker vs Boxlite 差异）
- `acp-proxy/src/proxy/sandbox/ociCliSandbox.ts`
  - Docker/podman/nerdctl 实现：复用 `ContainerSandbox` 做实例管理；启动 agent 时用 `cliRuntime`（避免 `docker cp`）
- `acp-proxy/src/proxy/sandbox/boxliteSandboxAdapter.ts`
  - Boxlite 实现：复用 `BoxliteSandbox`；短期只保证 `exec`/`inspect`/`stop`/`remove`/`list`，`openAgent` 先复刻当前逻辑（exec 模式）
- `acp-proxy/src/proxy/utils/*`
  - `validate.ts` / `jsonRpc.ts` / `secrets.ts` / `args.ts` / `time.ts`

---

## 2) 实施计划（按 2–5 分钟颗粒度拆分，TDD 优先）

### Task 1: 建立 `src/proxy/` 骨架与最小可编译入口

**Files:**

- Create: `acp-proxy/src/proxy/runProxyCli.ts`
- Create: `acp-proxy/src/proxy/index.ts`
- (暂不改) Modify: `acp-proxy/src/proxyCli.ts`（等新入口具备最小功能再切）
- Test: `acp-proxy/src/proxy/runProxyCli.test.ts`

**Step 1: 写一个会失败的单测（仅验证导出存在/可调用）**

```ts
// acp-proxy/src/proxy/runProxyCli.test.ts
import { describe, expect, it } from "vitest";
import { runProxyCli } from "./runProxyCli.js";

describe("proxy/runProxyCli", () => {
  it("exports runProxyCli", () => {
    expect(typeof runProxyCli).toBe("function");
  });
});
```

**Step 2: 运行测试确认失败**

Run: `pnpm -C acp-proxy test -- -t "proxy/runProxyCli"`
Expected: FAIL（找不到模块或 runProxyCli 未导出）

**Step 3: 实现最小入口（先只抛出“未实现”，让测试过）**

```ts
// acp-proxy/src/proxy/runProxyCli.ts
export async function runProxyCli(): Promise<void> {
  throw new Error("not implemented");
}
```

**Step 4: 运行测试确认通过**

Run: `pnpm -C acp-proxy test -- -t "proxy/runProxyCli"`
Expected: PASS

**Step 5: Commit**

```powershell
git add acp-proxy/src/proxy/runProxyCli.ts acp-proxy/src/proxy/runProxyCli.test.ts
git commit -m "feat(acp-proxy): scaffold new proxy directory"
```

---

### Task 2: 抽出纯工具函数（从旧 `proxyCli.ts` 迁移，保证行为不变）

**Files:**

- Create: `acp-proxy/src/proxy/utils/args.ts`
- Create: `acp-proxy/src/proxy/utils/validate.ts`
- Create: `acp-proxy/src/proxy/utils/secrets.ts`
- Create: `acp-proxy/src/proxy/utils/jsonRpc.ts`
- Test: `acp-proxy/src/proxy/utils/validate.test.ts`
- Test: `acp-proxy/src/proxy/utils/secrets.test.ts`

**Step 1: 写 failing tests（覆盖 validateRunId/validateInstanceName 的关键约束）**

```ts
import { describe, expect, it } from "vitest";
import { validateRunId, validateInstanceName } from "./validate.js";

describe("validate", () => {
  it("rejects empty run_id", () => {
    expect(() => validateRunId("")).toThrow(/run_id/);
  });
  it("rejects run_id with path separators", () => {
    expect(() => validateRunId("a/b")).toThrow();
  });
  it("accepts instance_name basic", () => {
    expect(validateInstanceName("abc-1_.")).toBe("abc-1_.");
  });
});
```

**Step 2: 运行测试确认失败**

Run: `pnpm -C acp-proxy test -- -t "validate"`
Expected: FAIL（模块/导出不存在）

**Step 3: 迁移旧实现（从 `acp-proxy/src/proxyCli.ts` 直接剪切/粘贴，保持逻辑一致）**

- 把以下函数“原样迁移”（只改 import/export）：
  - `pickArg` → `utils/args.ts`
  - `validateRunId`/`validateInstanceName`/`isRecord` → `utils/validate.ts`
  - `redactSecrets`/`pickSecretValues` → `utils/secrets.ts`
  - `isJsonRpcRequest`/`isJsonRpcResponse`/`isJsonRpcNotification` 相关 → `utils/jsonRpc.ts`

**Step 4: 运行测试确认通过**

Run: `pnpm -C acp-proxy test -- -t "validate"`
Expected: PASS

**Step 5: Commit**

```powershell
git add acp-proxy/src/proxy/utils
git commit -m "refactor(acp-proxy): extract proxy utils"
```

---

### Task 3: 定义新的抽象容器/沙箱接口 `ProxySandbox`

**Files:**

- Create: `acp-proxy/src/proxy/sandbox/ProxySandbox.ts`
- Create: `acp-proxy/src/proxy/sandbox/createProxySandbox.ts`
- Test: `acp-proxy/src/proxy/sandbox/ProxySandbox.test.ts`

**Step 1: 写 failing test（只验证 shape/基本行为）**

```ts
import { describe, expect, it } from "vitest";
import { createProxySandbox } from "./createProxySandbox.js";

describe("createProxySandbox", () => {
  it("creates sandbox adapter", () => {
    const adapter = createProxySandbox(
      {
        provider: "container_oci",
        runtime: "docker",
        image: "alpine:latest",
        workingDir: "/workspace",
      } as any,
      () => {},
    );
    expect(adapter.provider).toBe("container_oci");
  });
});
```

**Step 2: 定义接口（先最小集，后续按需加）**

```ts
// acp-proxy/src/proxy/sandbox/ProxySandbox.ts
import type { ProcessHandle, SandboxInstanceInfo, ListInstancesOpts } from "../../sandbox/types.js";

export type SandboxProviderKind = "boxlite_oci" | "container_oci";

export type AgentInit = {
  script?: string;
  timeout_seconds?: number;
  env?: Record<string, string>;
};

export type OpenAgentResult = {
  handle: ProcessHandle;
  created: boolean;
  initPending: boolean;
};

export interface ProxySandbox {
  readonly provider: SandboxProviderKind;
  readonly runtime: string | null;
  readonly agentMode: "entrypoint" | "exec";

  inspectInstance(instanceName: string): Promise<SandboxInstanceInfo>;
  listInstances(opts?: ListInstancesOpts): Promise<SandboxInstanceInfo[]>;
  stopInstance(instanceName: string): Promise<void>;
  removeInstance(instanceName: string): Promise<void>;
  execProcess(opts: {
    instanceName: string;
    command: string[];
    cwdInGuest: string;
    env?: Record<string, string>;
  }): Promise<ProcessHandle>;

  openAgent(opts: {
    runId: string;
    instanceName: string;
    workspaceGuestPath: string;
    agentCommand: string[];
    init?: AgentInit;
  }): Promise<OpenAgentResult>;
}
```

**Step 3: 实现 `createProxySandbox`（先只把配置解析+provider 选择跑通）**

- container_oci：创建 `OciCliProxySandbox`（Task 4 实现细节）
- boxlite_oci：创建 `BoxliteProxySandbox`（Task 5 实现细节）

**Step 4: 运行测试**

Run: `pnpm -C acp-proxy test -- -t "createProxySandbox"`
Expected: PASS

**Step 5: Commit**

```powershell
git add acp-proxy/src/proxy/sandbox
git commit -m "feat(acp-proxy): add ProxySandbox abstraction"
```

---

### Task 4: 实现 Docker(OCI CLI) 的 `ProxySandbox` 适配器（保证当前 Docker e2e 不退化）

**Files:**

- Create: `acp-proxy/src/proxy/sandbox/ociCliProxySandbox.ts`
- (复用/迁移) Modify or Move: `acp-proxy/src/proxyCli/containerOciCliAgent.ts` → `acp-proxy/src/proxy/sandbox/containerOciCliAgent.ts`
- Test: `acp-proxy/src/proxy/sandbox/ociCliProxySandbox.test.ts`

**Step 1: 写 failing test（不跑 docker，只测参数拼装/行为分支）**

- 重点：`openAgent` 在 `inspectInstance=missing` 时走“创建+返回 handle”，在 `running/stopped` 时走“attach/startAndAttach”。
- 用 `vi.fn()` mock 一个最小的 `ContainerSandbox`（只 mock 被调用的方法）。

**Step 2: 实现 `openAgent`：**

规则（与当前业务一致）：

- 若 `init.script` 非空且实例不是 missing：必须 `removeInstance` 后重新创建（确保 init 在 agent 前执行）
- 若实例不是 missing：检查 label `acp-proxy.agent_mode`（若不是 entrypoint 直接报错）
- missing：用 `CliRuntime` 直接 `docker run -i --name <instance> ...` 启动（`autoRemove: false`），entrypoint 用 `bash -lc` wrapper 执行 init + `exec agentCommand`
- stopped/running：用 `ContainerSandbox.attachInstance` 或 `startAndAttachInstance` 获取 handle

**Step 3: 运行单测**

Run: `pnpm -C acp-proxy test -- -t "ociCliProxySandbox"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/sandbox
git commit -m "feat(acp-proxy): implement oci cli sandbox adapter"
```

---

### Task 5: 实现 Boxlite 的 `ProxySandbox` 适配器（先最小功能，后续再增强）

**Files:**

- Create: `acp-proxy/src/proxy/sandbox/boxliteProxySandbox.ts`
- Test: `acp-proxy/src/proxy/sandbox/boxliteProxySandbox.test.ts`

**Step 1: failing test（不要求真实 Boxlite，可用 mock SandboxInstanceProvider）**

目标：`agentMode="exec"`，`openAgent` 会先 `ensureInstanceRunning`，再 `execProcess` 启动 agentCommand 并返回 handle。

**Step 2: 实现适配器**

- `openAgent`：复刻当前 `proxyCli.ts` 的 boxlite 分支逻辑（ensureInstanceRunning → execProcess agentCommand）
- 其余方法直接委托给 `BoxliteSandbox`（或其共同接口 `SandboxInstanceProvider`）

**Step 3: 运行单测**

Run: `pnpm -C acp-proxy test -- -t "boxliteProxySandbox"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/sandbox/boxliteProxySandbox.ts acp-proxy/src/proxy/sandbox/boxliteProxySandbox.test.ts
git commit -m "feat(acp-proxy): add boxlite sandbox adapter skeleton"
```

---

### Task 6: 引入 `RunManager`（runs map + TTL + per-run 串行队列）

**Files:**

- Create: `acp-proxy/src/proxy/runs/runTypes.ts`
- Create: `acp-proxy/src/proxy/runs/runManager.ts`
- Test: `acp-proxy/src/proxy/runs/runManager.test.ts`

**Step 1: failing test（队列串行、TTL 到期会触发回调）**

```ts
import { describe, expect, it, vi } from "vitest";
import { RunManager } from "./runManager.js";

describe("RunManager", () => {
  it("serializes per-run ops", async () => {
    const rm = new RunManager({ now: () => 0 });
    const order: string[] = [];
    const run = rm.getOrCreate({ runId: "r1", instanceName: "i1", keepaliveTtlSeconds: 1800 });
    await Promise.all([
      rm.enqueue(run.runId, async () => {
        order.push("a");
      }),
      rm.enqueue(run.runId, async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});
```

**Step 2: 实现最小 RunManager（复制旧逻辑：`runs` + `enqueueRunOp` + cleanup timer）**

**Step 3: 运行测试**

Run: `pnpm -C acp-proxy test -- -t "RunManager"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/runs
git commit -m "feat(acp-proxy): add RunManager"
```

---

### Task 7: 实现 `AgentBridge`（ACP NDJSON 读写、pending RPC、init marker、通知转发）

**Files:**

- Create: `acp-proxy/src/proxy/acp/agentBridge.ts`
- Test: `acp-proxy/src/proxy/acp/agentBridge.test.ts`

**Step 1: failing test（用内存流模拟 agent，验证 sendRpc 与 response 匹配）**

建议用 `TransformStream` 或 `ReadableStream`/`WritableStream` mock：

- 写入 request → agent 侧回写 response → bridge resolve

**Step 2: 迁移旧实现（从 `acp-proxy/src/proxyCli.ts` “原样搬运”，拆成类/函数）**

需要迁移的核心块（保持行为一致）：

- `writeToAgent`
- `sendRpc` + timeout
- `ensureInitialized`
- 读循环：response/notification/request（request 交给 `AcpClientFacade.handleRequest`）
- stderr 行读取与 init marker JSON 解析（`__ACP_PROXY_INIT_RESULT__:`）

**Step 3: 运行测试**

Run: `pnpm -C acp-proxy test -- -t "AgentBridge"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/acp
git commit -m "feat(acp-proxy): extract ACP agent bridge"
```

---

### Task 8: 实现 orchestrator 消息处理器（acp_open/prompt_send/.../sandbox_control）

**Files:**

- Create: `acp-proxy/src/proxy/handlers/handleAcpOpen.ts`
- Create: `acp-proxy/src/proxy/handlers/handlePromptSend.ts`
- Create: `acp-proxy/src/proxy/handlers/handleSessionControl.ts`
- Create: `acp-proxy/src/proxy/handlers/handleSandboxControl.ts`
- Test: `acp-proxy/src/proxy/handlers/*.test.ts`

**Step 1: 先做 acp_open 的 failing unit test（不依赖 docker）**

- mock `ProxySandbox.openAgent()` 返回一个 fake handle
- mock `AgentBridge.ensureInitialized()` 返回 ok
- 期望：发送 `{ type:"acp_opened", ok:true }`

**Step 2: 逐个 handler 迁移旧逻辑**

迁移来源：`acp-proxy/src/proxyCli.ts`

- `handleAcpOpen`：按 provider 决定 `openAgent` + init 处理
- `handlePromptSend`：ensure session → session/prompt → acp_update/prompt_result
- `handleSessionCancel`/`set_mode`/`set_model`
- `handleAcpClose`
- `handleSandboxControl` + `reportInventory`

**Step 3: 运行单测**

Run: `pnpm -C acp-proxy test -- -t "handlers"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/handlers
git commit -m "feat(acp-proxy): add orchestrator handlers"
```

---

### Task 9: 实现 orchestrator 连接层（WebSocket connect loop + heartbeat + dispatch）

**Files:**

- Create: `acp-proxy/src/proxy/orchestrator/orchestratorClient.ts`
- Modify: `acp-proxy/src/proxy/runProxyCli.ts`
- Test: `acp-proxy/src/proxy/orchestrator/orchestratorClient.test.ts`

**Step 1: failing test（最小：能建立连接并发送 register_agent）**

- 用 `ws` 的 `WebSocketServer` 起一个本地 server
- 启动 `orchestratorClient.connectLoop()` 一次
- 断言 server 收到 `register_agent`

**Step 2: 迁移旧实现**

迁移来源：`acp-proxy/src/proxyCli.ts`：

- `send` / `sendUpdate` / `registerAgent` / `heartbeatLoop` / `connectLoop` / message dispatch switch

**Step 3: 运行测试**

Run: `pnpm -C acp-proxy test -- -t "orchestratorClient"`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxy/orchestrator acp-proxy/src/proxy/runProxyCli.ts
git commit -m "feat(acp-proxy): implement orchestrator client"
```

---

### Task 10: 把旧入口切换到新 `proxy/`（保持外部行为不变）

**Files:**

- Modify: `acp-proxy/src/proxyCli.ts`
- (可选) Modify: `acp-proxy/src/index.ts`（可延后）
- Test: 复用现有 e2e

**Step 1: `proxyCli.ts` 退化为 thin wrapper**

目标：保留原有导出 `runProxyCli()`，但内部只做：

- 解析 `--config` / `--profile`
- 调用 `proxy/runProxyCli.ts`（传入 configPath/profile）

**Step 2: 跑基础测试**

Run: `pnpm -C acp-proxy test`
Expected: PASS（不含 docker e2e）

**Step 3: 跑 docker e2e**

Run: `pnpm -C acp-proxy test:docker`
Expected: PASS

**Step 4: Commit**

```powershell
git add acp-proxy/src/proxyCli.ts
git commit -m "refactor(acp-proxy): proxyCli delegates to new proxy implementation"
```

---

### Task 11: 清理遗留文件（删除未引用的过度封装/示例文件）

**Files:**

- Delete: `acp-proxy/src/launchers/types.ts`
- Delete: `acp-proxy/src/launchers/sandboxLauncher.ts`
- Delete or Move-to-docs: `acp-proxy/src/sandbox/containerOciGlue.ts`
- Delete: `acp-proxy/src/sandbox/providers/container_oci_cli.ts`

**Step 1: 全仓确认无引用**

Run:

```powershell
rg -n "launchers/sandboxLauncher|SandboxAgentLauncher|containerOciGlue|container_oci_cli" .
```

Expected: no matches（或仅剩 doc/plan 引用）

**Step 2: 删除文件**

**Step 3: 跑全量测试**

Run:

- `pnpm -C acp-proxy test`
- `pnpm -C acp-proxy test:docker`

Expected: PASS

**Step 4: Commit**

```powershell
git add -A
git commit -m "chore(acp-proxy): remove unused legacy glue and launchers"
```

---

## 执行交接

Plan complete and saved to `docs/plans/2026-01-29-acp-proxy-new-proxy-directory.md`. Two execution options:

1. **Subagent-Driven (this session)** - 我按 Task 逐个落地实现与回归
2. **Parallel Session (separate)** - 你开新会话并使用 @executing-plans 按计划执行

你想选哪一种？
