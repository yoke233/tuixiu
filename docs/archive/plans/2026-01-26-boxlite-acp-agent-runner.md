---
title: "BoxLite + ACP 多 Agent Runner 实施计划"
owner: "@tuixiu-maintainers"
status: "archived"
result: "done"
last_reviewed: "2026-01-27"
superseded_by: "docs/00_overview/roadmap.md"
---

# BoxLite + ACP 多 Agent Runner 实施计划（已归档）

> ⚠️ **已归档 / 已过期**：本文件仅用于历史追溯，可能与当前实现不一致，请勿作为开发依据。  
> 当前请以 `README.md`、`docs/00_overview/roadmap.md`、`docs/03_guides/quick-start.md` 为准。

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 在现有 `tuixiu/` 架构不大改的前提下，让 `acp-proxy/` 支持“可插拔启动器（launcher）”：既能像现在一样在宿主机 `spawn()` 运行 ACP Agent，也能用 BoxLite 把 ACP Agent 放到 OCI/micro-VM 沙箱里运行；同时把 “Codex” 降级为一个默认 profile，允许切换到任意 ACP 兼容 Agent。

**（你选择的落地形态 A）**：`backend/` + `frontend/` 继续跑在 本机；`acp-proxy/` 跑在 WSL2；ACP Agent 跑在“沙箱 Provider”里（第一版 BoxLite，未来可替换）。

**Architecture:** 把 `acp-proxy` 的能力拆成三层：
1) `SandboxProvider`：负责“在某种沙箱/运行时里启动进程，并提供可持续读写的 stdio（流式）”。
2) `AgentLauncher`：负责把 `agent_command` 交给 `SandboxProvider` 启动，组装成 `AcpTransport`。
3) `AcpBridge`：只依赖 `AcpTransport` 与 `@agentclientprotocol/sdk`，实现 ACP initialize/session/prompt、session/load 复用等。

后端继续用 WebSocket 把 `run_id/prompt/cwd` 发给 proxy；多 Agent 的第一版通过“启动多个 proxy 实例”实现（每个 proxy 配置不同 `agent.id/agent_command/sandbox`）。

**Tech Stack:** Node.js + TypeScript（`acp-proxy/`）+ `@agentclientprotocol/sdk`；可选 `@boxlite-ai/boxlite`（仅 WSL2/Linux）。

---

### Task 1: 固化 A 形态运行方式（WSL2 网络 + 路径映射）

**Files:**
- Create: `docs/archive/plans/2026-01-26-boxlite-acp-agent-runner-design.md`
- Modify: `docs/03_guides/environment-setup.md`

**Step 1: 记录 A 形态的关键配置**
- `orchestrator_url`：在 WSL2 里不能用 `localhost`，需要用 Windows Host IP（建议写一个“如何取 IP”的命令片段）。
- `cwd`：后端传 Windows 路径时，proxy 需要转换为 WSL 路径（例如 `D:\\repo\\x` → `/mnt/d/repo/x`）。

**Step 2: 把环境前置条件写清楚**
- BoxLite 需要 WSL2 + KVM（Linux `/dev/kvm` 可用）
- 约束：`@boxlite-ai/boxlite` 没有 Windows 原生二进制

**Verification:**
- 文档中明确说明：proxy 如何从 WSL2 连接 Windows 后端；以及 worktree 路径如何映射

---

### Task 2: 引入 `SandboxProvider`/`ProcessHandle`/`AcpTransport` 抽象（不改变行为）

**Files:**
- Create: `acp-proxy/src/sandbox/types.ts`
- Create: `acp-proxy/src/sandbox/hostProcessSandbox.ts`
- Create: `acp-proxy/src/launchers/types.ts`
- Create: `acp-proxy/src/launchers/defaultLauncher.ts`
- Modify: `acp-proxy/src/acpBridge.ts`
- (Optional) Create: `acp-proxy/src/acpBridge.test.ts`

**Step 1: 写 SandboxProvider 接口（先让编译失败）**

`acp-proxy/src/sandbox/types.ts`

```ts
export type ProcessHandle = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  close: () => Promise<void>;
  onExit?: (cb: (info: { code: number | null; signal: string | null }) => void) => void;
};

export type RunProcessOpts = { command: string[]; cwd: string; env?: Record<string, string> };
export interface SandboxProvider {
  runProcess(opts: RunProcessOpts): Promise<ProcessHandle>;
}
```

**Step 2: 实现 `HostProcessSandbox`（复用现有 spawn 逻辑）**
- 内部复用现在的 win32 `cmd.exe /c` shim 判断逻辑（用于 Windows 跑 proxy 的场景；A 形态下 proxy 在 WSL2 会走普通 spawn）
- 输出：把 Node stream 包装为 Web Streams（`Readable.toWeb/Writable.toWeb`）
- `close()` 负责 kill 子进程

**Step 3: 实现 `DefaultAgentLauncher` + `AcpTransport`**
- `DefaultAgentLauncher` 内部注入 `SandboxProvider`，调用 `runProcess({command,cwd,env})`
- 把 `ProcessHandle.stdin/stdout` 映射为 `AcpTransport.input/output`

**Step 4: 改造 `AcpBridge` 只依赖 launcher/transport**
- `AcpBridge` 构造参数改为 `{ launcher, cwd, log, onSessionUpdate }`
- `ensureSpawned()` 改成 `ensureConnected()`：如果 transport 不存在则 `await launcher.launch(...)`

**Verification:**
- Run: `pnpm -C acp-proxy typecheck`
- Expected: 通过；功能行为不变（仍可跑 `pnpm -C acp-proxy dev` 连上后端）

---

### Task 3: 新增 `sandbox` 配置（让 Codex/BoxLite 都变成可替换项）

**Files:**
- Modify: `acp-proxy/src/config.ts`
- Modify: `acp-proxy/config.json.example`
- Modify: `docs/03_guides/quick-start.md`

**Step 1: 配置 schema 增加 sandbox/provider**
- `sandbox.provider: "host_process" | "boxlite_oci"`（默认 `host_process`）
- BoxLite 相关字段先保留为可选，下一 Task 再实现
- 增加 `pathMapping`（可选）：用于把后端传来的 Windows 路径转换成 WSL 路径（A 形态必须）

**Step 2: 文档强调“任意 ACP Agent 都可替换”**
- 示例：`agent_command` 可替换为其它 ACP agent 启动命令（例如 `npx --yes <some-acp-agent>`）

**Verification:**
- Run: `pnpm -C acp-proxy test`
- Expected: 通过（至少 config test 需要补充 sandbox 默认）

---

### Task 4: 实现 `BoxliteSandbox`（可选能力，按环境启用）

**Files:**
- Create: `acp-proxy/src/sandbox/boxliteSandbox.ts`
- Modify: `acp-proxy/src/config.ts`
- Modify: `acp-proxy/src/index.ts`
- (Optional) Create: `acp-proxy/src/sandbox/boxliteSandbox.test.ts`

**Step 1: 增加 BoxLite provider 配置**
建议字段：
- `boxlite.image`（如 `ghcr.io/your-org/acp-codex:latest` 或 `node:20-slim`）
- `boxlite.workingDir`（如 `/workspace`）
- `boxlite.volumes[]`（把 worktree 挂载进 `/workspace`）
- `boxlite.env`（API key 等）
- `boxlite.cpus/memoryMib`

**Step 2: `BoxliteSandbox.runProcess()` 产出 ProcessHandle**
关键点：
- `await import("@boxlite-ai/boxlite")` 动态加载，避免 Windows 安装失败
- 优先走官方导出的低层 API：`JsBoxlite.withDefaultConfig()` → `runtime.create(...)` → `box.exec(...)`（得到 `Execution`，可拿 stdin/stdout/stderr）
- `stdin = await execution.stdin()`，`stdout = await execution.stdout()`：封装成 `WritableStream/ReadableStream<Uint8Array>`
- `close()`：停止 execution/stop box

**Step 3: 在不支持的平台给出清晰错误**
- Windows 非 WSL2：提示“BoxLite 需要 WSL2/Linux，当前请用 sandbox.provider=host_process”

**Verification:**
- Run: `pnpm -C acp-proxy test`
- Expected: 通过（BoxLite 测试可做平台条件跳过）

---

### Task 5: 准备一个可运行的 ACP Agent 容器镜像（以 Codex 为例）

**Files:**
- Create: `acp-proxy/agent-images/codex-acp/Dockerfile`
- Modify: `docs/03_guides/environment-setup.md`
- Modify: `docs/03_guides/quick-start.md`

**Step 1: 写 Dockerfile（最小可运行）**
- 基于 `node:20-slim`
- 安装 git（Agent 需要提交）
- 默认启动：`codex-acp`
- 约定工作目录 `/workspace`（由 BoxLite volume mount 注入 repo/worktree）

**Step 2: 给出运行/验证命令**
- 构建镜像
- proxy 配置 `sandbox.provider=boxlite_oci` + `boxlite.image=<built-image>`
- 启动一条 Run，确认能收到 ACP initialize/session/prompt 回包

**Verification:**
- 文档中有一条“最短链路”可复制粘贴（WSL2/Linux）

---

### Task 6（可选增强）: 前端补齐“选择 Agent”与“Agent 类型/sandbox 可见性”

**Files:**
- Modify: `frontend/src/pages/IssueDetailPage.tsx`
- Modify: `frontend/src/api/agents.ts`（如缺失则创建）
- Modify: `backend/src/routes/issues.ts`（如需返回 agents 列表/过滤 sandbox）

**Step 1: Issue 启动时允许选择 agentId**
- UI：下拉框列出 online agents（后端已有 `agentId` 参数支持）

**Step 2: 在详情页展示 sandbox/环境提示**
- 若 agent 运行在 WSL2/BoxLite：展示“沙箱模式”
- 若 agent offline：提示无法启动

**Verification:**
- Run: `pnpm -C frontend test`
- Expected: 新增/更新的测试用例通过
