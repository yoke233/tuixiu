---
title: "仓库深度走读报告（tuixiu）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-02-01"
---

# 仓库深度走读报告（tuixiu）

生成时间：2026-02-01  
走读基线：`main` 分支，commit `a5342c86983bc4fe406071968f12405f3573214e`（当前工作区为 dirty：存在本地未提交修改/删除，见 `git status`）

本报告目标读者：后端/前端/平台工程（能上手跑起来、能沿关键链路定位、能安全二开）。

---

## 01. 项目概览

### 1.1 仓库定位（What is this）

TuiXiu（ACP 协作台）是一个把 GitHub/GitLab/Codeup 的 Issue “交给 ACP 兼容 Coding Agent 执行”的协作系统：后端做编排与数据落库，`acp-proxy` 负责 WS ↔ ACP 桥接并在沙箱中启动 agent，前端实时展示事件流与产物并驱动 PR/审批闭环。（见 `README.md`、`docs/01_architecture/system-architecture.md`）

### 1.2 目录与职责边界（Top-level map）

- `backend/`：Fastify Orchestrator（REST + WebSocket Gateway）+ Prisma(Postgres)；入口 `backend/src/index.ts`
- `acp-proxy/`：WS ↔ ACP 桥接 + sandbox/agent launcher；入口 `acp-proxy/src/index.ts` → `acp-proxy/src/runProxyCli.ts:37`
- `frontend/`：Vite + React UI；入口 `frontend/src/main.tsx`、路由 `frontend/src/App.tsx`
- `docs/`：权威架构/模块/指南/Runbook（带 front matter）；入口 `docs/README.md`
- `scripts/`：当前仅见 `scripts/docs_lint.py`（无 md→html 渲染脚本）
- `.worktrees/`：运行时生成 worktrees（文档明确“不要手改/不要提交”）

### 1.3 快速指标（Quick stats）

- 工作区是 `pnpm` workspace：根 `package.json` + `pnpm-workspace.yaml`（backend/frontend/acp-proxy 三包）
- 语言/文件：`.ts`≈318、`.tsx`≈66、`.md`≈129（统计来自 `rg --files`）
- 核心依赖：
  - backend：Fastify 5、Prisma、Zod、`@agentclientprotocol/sdk`
  - acp-proxy：`ws`、`convict`、BoxLite、`@agentclientprotocol/sdk`
  - frontend：React 19、React Router 7、Tailwind v4、Vitest

---

## 02. 架构地图（分层 + 核心对象 + 数据流）

### 2.1 分层与边界（证据）

系统分三层（与仓库结构一致）：

1) UI：`frontend/`（HTTP 调 REST + WS 订阅事件流）  
2) Orchestrator：`backend/`（API + WS 网关 + DB + Git/PR 编排）  
3) 执行层：`acp-proxy/`（连接 orchestrator 的 `/ws/agent`，启动 sandbox/agent，并把 ACP 事件回传）  

对应说明见：`docs/01_architecture/system-architecture.md`。

### 2.2 核心数据模型（Prisma）

以 `backend/prisma/schema.prisma` 为准（节选要点）：

- `Project`：repoUrl、scmType、token、workspaceMode/Policy、executionProfile、runtime skills 开关等
- `Issue`：需求池实体（默认 `pending`，通过 `/api/issues/:id/start` 进入 `running`）
- `Agent`：由 proxy 注册/心跳维持在线；核心字段 `proxyId/status/currentLoad/maxConcurrentRuns`
- `Run`：一次执行；持久化 `acpSessionId/workspacePath/branchName/sandboxInstanceName/sandboxStatus`、以及 PR 状态（`scmPr*`）
- `Event`：事件流（source: `acp|gitlab|system|user`）
- `Artifact`：产物（branch/pr/report/ci_result…）
- `Approval`：高危动作（create_pr/merge_pr/publish_artifact）的审批队列
- `Task/Step`：更高层的工作流抽象（支持 auto-advance 与多 executor）

关键模型位置（便于速查）：
- `Run`：`backend/prisma/schema.prisma`（包含 sandbox 与 SCM 状态字段）
- `Event/Artifact/Approval`：`backend/prisma/schema.prisma`（约在 model Event/Artifact/Approval 段）

### 2.3 模块依赖图（Mermaid）

```mermaid
graph TD
  U[Browser/User] -->|HTTP /api/*| FE[frontend (Vite+React)]
  U -->|WS /ws/client| BE_WS_CLIENT[backend WS /ws/client]

  FE -->|HTTP /api/*| BE_HTTP[backend (Fastify REST)]
  FE -->|WS subscribe event_added| BE_WS_CLIENT

  BE_HTTP --> DB[(PostgreSQL via Prisma)]
  BE_WS_CLIENT --> DB

  subgraph Backend Core
    BE_INDEX[backend/src/index.ts]
    WS_GATEWAY[backend/src/websocket/gateway.ts]
    ACP_TUNNEL[backend/src/modules/acp/acpTunnel.ts]
    RUN_START[backend/src/modules/runs/startIssueRun.ts]
    SCM[backend/src/modules/scm/*]
    APPROVALS[backend/src/modules/approvals/*]
    WORKFLOW[backend/src/modules/workflow/*]
  end

  BE_INDEX --> WS_GATEWAY
  BE_INDEX --> ACP_TUNNEL
  BE_INDEX --> RUN_START
  BE_INDEX --> SCM
  BE_INDEX --> APPROVALS
  BE_INDEX --> WORKFLOW

  WS_GATEWAY -->|WS /ws/agent| PROXY[acp-proxy]
  ACP_TUNNEL -->|sendToAgent(acp_open/prompt_send)| WS_GATEWAY

  PROXY -->|stdio/NDJSON (ACP)| AGENT[ACP Agent]
  PROXY -->|sandbox provider| SANDBOX[(container_oci/boxlite_oci/host_process)]
  SANDBOX --> AGENT
```

---

## 03. 入口与执行流程（Entrypoint → Critical Path）

本仓库“最关键链路”可以用一个锚点描述：**从 UI 启动 Run，到 agent 在 sandbox 内开始工作并把流式输出写入 Event，再到创建 PR/进入审批**。

### 3.1 入口点清单（Entrypoints）

- Backend：`backend/src/index.ts`（Fastify 启动与路由注册，`await server.listen(...)` 在 `backend/src/index.ts:416`）
- Proxy：`acp-proxy/src/index.ts` → `acp-proxy/src/runProxyCli.ts:37`
- Frontend：`frontend/src/main.tsx` + 路由 `frontend/src/App.tsx`

### 3.2 关键链路 A：启动 Run（POST /api/issues/:id/start）

关键步骤（按调用链排列，带定位点）：

1) UI 发起启动 Run  
   - 入口页：`frontend/src/pages/issueDetail/IssueDetailPage.tsx`
   - 操作区：`frontend/src/pages/issueDetail/sections/ConsoleCard.tsx`（“请先启动 Run”提示、全屏控制台跳转等）

2) Backend 接口：`POST /api/issues/:id/start`  
   - 路由：`backend/src/routes/issues.ts:150`
   - 实际逻辑：`backend/src/modules/runs/startIssueRun.ts:66`

3) `startIssueRun` 做 4 件事（强约束路径）
   - 选 agent：优先指定 `agentId`，否则选 `status=online && currentLoad < maxConcurrentRuns`
   - 创建 Run + 推进 Issue/Agent 状态：Run=`running`、Issue=`running`、Agent `currentLoad +1`
   - 创建 workspace（依赖注入的 `createWorkspace`，从 `backend/src/index.ts` 传入；当前实现返回 `workspaceMode=clone`，workspacePath 固定 `/workspace`，并生成 `run/<name>` 分支名）
   - 组装 prompt + init：写入大量 `TUIXIU_*` 环境变量，合并 init scripts，并通过 ACP 隧道发送到 proxy/agent（`backend/src/modules/runs/startIssueRun.ts:610`）

4) ACP 隧道：确保 sandbox/agent 已打开，再发送 prompt  
   - `backend/src/modules/acp/acpTunnel.ts:69`（创建隧道）
   - `backend/src/modules/acp/acpTunnel.ts:451`（`promptRun`：必要时发送 `acp_open`，随后 `prompt_send`，等待 `prompt_result`，并把 `acpSessionId` 落库）

5) Proxy 收到 `acp_open`，启动 sandbox 并初始化 agent  
   - WS message dispatch：`acp-proxy/src/runProxyCli.ts`（`onMessage` 分发到 handlers）
   - `acp_open` handler：`acp-proxy/src/handlers/handleAcpOpen.ts:12`
     - `ensureRuntime/ensureInitialized`：建立 per-run runtime 状态
     - `runInitScript`：执行 `init.script`（由后端下发，包含 workspace 初始化/role init/skills mount 相关）
     - `startAgent`：启动 ACP agent 进程（默认 `agent_command=["codex-acp"]`）

6) Proxy/Agent 输出流式更新，回写 backend → Event → UI  
   - Proxy 将 ACP `session/update` 等转成 `acp_update` 回传 backend
   - backend `/ws/agent` 收到后：
     - 进入 `backend/src/websocket/gateway.ts`（agent connection 消息处理）
     - 部分更新会落为 `Event(source="acp", type="acp.update.received")`（由 `backend/src/modules/acp/acpTunnel.ts` 负责持久化与 chunk 合并）
     - 同时广播到 `/ws/client`，前端 `RunConsole` 增量渲染（`frontend/src/components/RunConsole.tsx`）

### 3.3 关键链路 B：继续对话（Run.prompt）

两条入口都存在（HTTP 与 WS client command），共同目标：调用 `acpTunnel.promptRun(...)` 并尽量复用 `Run.acpSessionId`：

- HTTP：`backend/src/routes/runs.ts`（`POST /api/runs/:id/prompt`，并支持图片附件物化）
- WS（UI 直连 backend WS client）：`backend/src/websocket/gateway.ts` 内 `handleClientCommand`（`type=prompt_run`）

当检测到 sandbox `missing` 时，会走降级：
- 用 `buildChatContextFromEvents(...)` 构造上下文
- 用 `buildRecoveryInit(...)` 构造恢复用 init（见 `backend/src/websocket/gateway.ts` 中对应逻辑）

### 3.4 关键链路 C：创建 PR / 合并 PR（受控动作 + 审批）

- 创建 PR：`backend/src/routes/runs.ts` → `backend/src/modules/scm/runReviewRequest.ts`
  - 先校验 sandbox git push 能力：`isSandboxGitPushEnabled(...)`（由 agent capabilities 决定）
  - 先执行 `sandboxGitPush`（后端通过 WS 让 proxy 在 sandbox 内 push）再调用 GitLab/GitHub API 创建 PR
  - 结果写回 `Run.scm*` 字段（而不是仅写 Artifact），并可推进 Run 到 `waiting_ci`
- 合并 PR：`POST /api/runs/:id/merge-pr` 默认返回 `APPROVAL_REQUIRED` 并创建 `Approval`，由 `/api/approvals` 队列批准后执行（见 `backend/src/routes/runs.ts` 的审批逻辑）

### 3.5 时序图（Mermaid：启动 Run）

```mermaid
sequenceDiagram
  autonumber
  participant UI as Browser UI (frontend)
  participant BE as Orchestrator (backend)
  participant DB as Postgres (Prisma)
  participant WS as WS /ws/agent (gateway)
  participant PX as acp-proxy
  participant SB as Sandbox (container_oci/boxlite/host)
  participant AG as ACP Agent

  UI->>BE: POST /api/issues/:id/start
  BE->>DB: create Run; update Issue/Agent
  BE->>BE: startIssueRun: build prompt + initEnv + initScript
  BE->>WS: sendToAgent(acp_open)
  WS->>PX: WS msg acp_open
  PX->>SB: ensureInstanceRunning + runInitScript
  PX->>AG: start agent (stdio/NDJSON)
  BE->>WS: sendToAgent(prompt_send)
  WS->>PX: WS msg prompt_send
  PX->>AG: ACP session/prompt
  AG-->>PX: session/update (stream)
  PX-->>WS: acp_update
  WS-->>BE: acpTunnel persist events (chunk/flush)
  BE-->>UI: WS /ws/client event_added
```

---

## 04. 核心模块深挖（High-Leverage Subsystems）

### 4.1 Backend 组装点（`backend/src/index.ts`）

职责：把配置、存储、WS 网关、ACP 隧道、路由与鉴权组装起来。

关键点：
- Env 校验：`backend/src/config.ts`（Zod；并提供 workspaces/attachments/skill-packages 的默认目录）
- 静态资源托管：`backend/src/index.ts` 会尝试从多个 root 提供 `index.html`，并在找不到 bundle 时给出清晰 404 文案（减少“白屏”）
- 鉴权/授权：
  - `registerAuth(...)` + `preHandler` 钩子统一保护 `/api/*`（放行 `/api/auth/*`、`/api/health`、webhooks、proxy register 等）
  - 对 Project/Role/Policy/WorkflowTemplate 的写操作做 admin gate（见 `backend/src/index.ts` 中 isProjectCreate/isRoleTemplateMutation... 判断）
- WebSocket：
  - `createWebSocketGateway(...).init(server)`：连接 `/ws/agent` 与 `/ws/client`
  - `createAcpTunnel(...)`：把 run 的 ACP 生命周期/事件持久化封装为可复用组件
  - `createSandboxControlClient(...)`：向 proxy 发起 sandbox 控制类命令（git push 等）

扩展点：
- 增加新的 REST 路由/模块：在 `backend/src/index.ts` 注册 `server.register(makeXxxRoutes(...), { prefix })`
- 增加新的系统级依赖（例如新 AttachmentStore/S3）：替换 `createLocalAttachmentStore` 的实现并注入到 routes/gateway

### 4.2 Run 启动与初始化（`backend/src/modules/runs/startIssueRun.ts`）

职责：把“需求池里的 Issue”转换成“可执行的 Run”，并把执行所需的 workspace、初始化脚本、环境变量、统一输入清单（`agentInputs`）一次性准备好。

关键流程（浓缩）：
- 选 Agent 与 RoleTemplate：RoleKey 可来自请求、Project 默认、或 PM 分析（见 `backend/src/modules/pm/pmAutomation.ts`）
- Workspace Policy：由 platform/project/role/profile 合并出 `resolvedWorkspacePolicy`（并写入 `Run.resolvedWorkspacePolicy/workspacePolicySource`）
- Prompt 组装：
  - workspace notice：来自 `Project.agentWorkspaceNoticeTemplate` 或 env `AGENT_WORKSPACE_NOTICE_TEMPLATE`
  - role prompt：渲染 `RoleTemplate.promptTemplate`
  - Issue 描述/验收/约束/测试要求拼接
- Init（关键）：
  - `init.env` 里写入大量 `TUIXIU_*`（project/run/workspace/branch/scm…）
  - runtime skills mounting：如果 `Project.enableRuntimeSkillsMounting` 且 Role 绑定了 skill versions，会在 `agentInputs` 中加入 skills 的 `downloadExtract` 输入项（由 proxy 落地到 `USER_HOME/.codex/skills`）
  - init.script：`buildWorkspaceInitScript()` + `RoleTemplate.initScript` 合并（并可设置 `initTimeoutSeconds`）

风险点（值得在代码评审时特别关注）：
- `RoleTemplate.initScript` 在 `acp-proxy` 所在机器/容器执行，等同远程代码执行能力；需要权限与审计（仓库文档也明确提示）
- Git token 进入 `init.env` 并被传入 proxy/sandbox；需要严格控制日志与 allowlist（proxy config 有 `agent_env_allowlist` 机制）

### 4.3 ACP 隧道与事件持久化（`backend/src/modules/acp/acpTunnel.ts`）

职责：把“多条 WS 消息 + ACP session 状态 + 流式输出”封装成 per-run 的状态机，并负责：
- `ensureOpen`：对每个 run 只打开一次 sandbox/agent（发送 `acp_open`，等待 `acp_opened`）
- `promptRun`：发送 `prompt_send`，等待 `prompt_result`（带 timeout），并写回 `Run.acpSessionId`
- chunk 合并：对 `*_chunk` 类 session update 做 buffer/flush（减少 DB 写压力与 UI 噪声）
- terminal 收尾：`persistPromptResult` + `finalizeRunIfRunning`（把 Run 从 running 推到 completed/failed，并驱动 task/PM 自动推进）

扩展点：
- 新增 session control（mode/model/config）：同文件内已有 `setSessionMode/setSessionModel/...` 模式可复用
- 调整超时/缓冲策略：通过 env（例如 `ACP_PROMPT_TIMEOUT_MS`）+ 常量（chunk flush interval/上限）

### 4.4 WS 网关（`backend/src/websocket/gateway.ts`）

职责：承接两类连接：
- proxy/agent：`/ws/agent`（注册、心跳、acp_update/result、sandbox inventory/status）
- 浏览器：`/ws/client`（订阅 event_added/artifact_added 等实时更新；也可直接发 `prompt_run` 命令）

关键机制：
- agent 注册：`register_agent` 会 upsert `Agent(proxyId)` 并标记 online，同时会 `resumeRunningRuns(...)`（proxy 重连后尝试续跑/提醒）
- client 直发 prompt：`handleClientCommand` 会写入一条 `user.message` event（best-effort），再调用 `acpTunnel.promptRun`

扩展点：
- 新增 WS 消息类型：按 `AnyAgentMessage` / `ClientCommand` 增加 schema 与 handler
- 增加广播事件：统一走 `broadcastToClients({ type, ... })`，前端按 type 分发

### 4.5 Proxy：WS ↔ ACP 桥接与 sandbox 抽象（`acp-proxy/`）

核心结构：
- `acp-proxy/src/runProxyCli.ts`：连接 orchestrator（WS），分发消息到 handlers，并周期性上报 inventory
- handlers：
  - `handleAcpOpen`：确保 sandbox runtime、应用 `agentInputs`（落地 workspace/skills 等输入）、启动 agent、初始化 ACP
  - `handlePromptSend`：将 orchestrator 的 `prompt_send` 转成 ACP prompt 并把更新转回 `acp_update`/`prompt_result`
  - `handleSandboxControl`：执行 git push / 运行命令等 sandbox 控制类动作
- sandbox/provider：
  - `container_oci` / `boxlite_oci` / `host_process` 统一抽象在 `acp-proxy/src/sandbox/*`、`acp-proxy/src/platform/*`

扩展点：
- 新增 sandbox provider：实现 `ProxySandbox` 接口并在 `createProxySandbox(...)` 里接入
- 新增 skills 分发/校验：在 `acp-proxy/src/skills/*` 扩展 manifest 解析与下载策略

### 4.6 Frontend：RunConsole 与交互面（`frontend/`）

关键点：
- 路由与权限：`frontend/src/App.tsx`，`RequireAuth/RequireAdmin`
- Issue 详情页组合：`frontend/src/pages/issueDetail/IssueDetailPage.tsx`（Summary/Console/Run/Changes）
- RunConsole：`frontend/src/components/RunConsole.tsx`
  - 对事件做归并（`buildConsoleItems`）、过滤噪声（例如 sandbox status 文本）
  - 默认只展示最近 N 条，支持“显示更多/全部”，并处理滚动粘滞（避免 live 更新把用户卷走）

扩展点：
- 新增事件类型展示：从 `buildConsoleItems(...)` 与 toolCallInfo 体系接入
- 新增卡片/区块：IssueDetailPage 采用“sections”组织，局部扩展成本低

---

## 05. 上手实操（本地跑起来）

以仓库文档为准：`README.md` 与 `docs/03_guides/quick-start.md`。

最小路径（Windows / PowerShell，三终端）：

```powershell
pnpm install
docker compose up -d

Copy-Item backend/.env.example backend/.env
Copy-Item acp-proxy/config.toml.example acp-proxy/config.toml
```

```powershell
# 终端 1
pnpm -C backend dev
```

```powershell
# 终端 2
$env:OPENAI_API_KEY="..."
pnpm -C acp-proxy dev
```

```powershell
# 终端 3
pnpm -C frontend dev
```

访问：`http://localhost:5173/login`（首次可初始化管理员）

常见坑（与代码/配置强相关）：
- 前端直连 backend 静态资源：`backend/src/index.ts` 会尝试托管 `frontend/dist`，但开发态建议直接用 Vite（5173）
- Proxy 连接地址：`acp-proxy/config.toml` 的 `orchestrator_url` 要与 backend 的 `/ws/agent` 一致
- Token/Secrets：Project 的 SCM token 当前会写入 DB（明文）；`RoleTemplate.initScript` 有执行风险（仅在可信环境使用）

---

## 06. 二次开发指南（可操作清单）

### 6.1 新增一种“执行器”（ExecutorType）

目标：支持新的 Step/Run 执行方式（例如 “policy gate”、“custom pipeline”）。

- 数据层：`backend/prisma/schema.prisma`（`ExecutorType` enum）
- 调度分发：`backend/src/modules/workflow/executionDispatch.ts`（按 `executorType` 分支）
- 实现执行：在 `backend/src/executors/*` 增加 `startXxxExecution` 并接入 dispatch
- 事件与状态：确保写入 `Run.status`、必要时写 `Event/Artifact`，并触发 `triggerTaskAutoAdvance(...)`（保持工作流推进一致）

### 6.2 新增一种受控动作（ApprovalAction）

- Schema：`backend/prisma/schema.prisma`（`ApprovalAction/ApprovalStatus`）
- 请求创建：`backend/src/modules/approvals/approvalRequests.ts`（参照 create_pr/merge_pr）
- 路由暴露：`backend/src/routes/approvals.ts` 与对应业务路由（例如 runs.ts）
- UI：在 `frontend/src/pages/AdminPage.tsx` 或相关页面增加审批队列展示/操作

### 6.3 新增/替换 SCM provider

- 统一入口：`backend/src/modules/scm/runReviewRequest.ts`（create/merge/sync）
- provider 细节：`backend/src/integrations/github.ts`、`backend/src/integrations/gitlab.ts`
- Project 配置：`Project.scmType/*AccessToken/*WebhookSecret` 等字段

### 6.4 新增 runtime skills

- 后端侧：Role 绑定 skills（`RoleSkillBinding` / `SkillVersion`），`startIssueRun` 会在 `agentInputs` 中构造 skills 输入项并下发
- proxy 侧：`handleAcpOpen` 会按 `agentInputs` 落地输入，skills 以 `USER_HOME/.codex/skills` 对 agent 可见
- 风险：对下载大小/来源做限制（`acp-proxy/config.toml.example` 已预留 `skills_download_max_bytes`）

---

## 07. 仓库文档总结（Docs for Dev/Agent）

优点：
- 文档“以真实实现为准”，并标记过时内容；且统一 front matter（见 `docs/01_architecture/system-architecture.md`、`docs/02_modules/codebase-navigation.md`）
- 跑通闭环的步骤清晰：`docs/03_guides/quick-start.md`
- Runbook/Process/Decision 分层明确：`docs/06_runbooks`、`docs/05_process`、`docs/04_decisions`

建议：
- 增补“一页式 SSOT 入口”：把 README 与 `docs/README.md` 做明确分工（新手入口/深入链接），避免重复与漂移
- 为“安全敏感点”增加强提示与最小权限建议（token 明文、initScript 风险、skills 下载来源）

---

## 08. 评分（100 分制，多维度，证据驱动）

总分（建议）：78 / 100

1) 架构清晰度：9/10  
证据：三层结构与关键数据流在 `docs/01_architecture/system-architecture.md` 清晰落地；代码组织与仓库结构一致（backend/acp-proxy/frontend）。

2) 可扩展性：8/10  
证据：workflow 的 executor 分发在 `backend/src/modules/workflow/executionDispatch.ts`；SCM 抽象在 `backend/src/modules/scm/runReviewRequest.ts`；sandbox/provider 抽象在 `acp-proxy/src/sandbox/*`。  
扣分：部分扩展仍需要跨层改动（schema+backend+proxy+ui），缺少“插件式注册”。

3) 可维护性：7/10  
证据：Zod schema、TypeScript ESM、模块分目录清晰；docs 维护意识强。  
扣分：若干关键文件较长（例如 `acpTunnel.ts`），建议进一步拆分并补充更细粒度测试。

4) 可靠性与错误处理：8/10  
证据：run/issue 队列化（避免并发踩踏）、prompt timeout、chunk buffer、proxy 重连续跑（`backend/src/websocket/gateway.ts` 的 `resumeRunningRuns`）、审批动作默认受控。  
扣分：缺少更系统的幂等键/重放设计说明（尤其是 webhook/CI 回写）。

5) 可观测性：7/10  
证据：Event 模型与 WS 广播让“可回放的执行轨迹”天然存在。  
扣分：缺少 trace/span、结构化 request id 全链路贯穿；日志策略偏分散。

6) 文档质量：9/10  
证据：`docs/03_guides/quick-start.md`、`docs/02_modules/codebase-navigation.md`、`docs/01_architecture/system-architecture.md`。

7) 示例与教程：7/10  
证据：quick start + API 示例（curl/pwsh）。  
扣分：缺少一个可一键跑通的端到端 demo（包含真实 repo + mock agent 输出 + PR 创建的 sandbox stub）。

8) 测试与 CI：7/10  
证据：backend/frontend/acp-proxy 都配置了 Vitest；前端 `RunConsole.test.tsx` 等覆盖关键展示逻辑。  
扣分：未看到稳定的 e2e（UI+WS+DB+proxy）流水线；建议引入最小 e2e 作为回归保护。

9) 安全与配置管理：6/10  
证据：文档已提示风险；proxy 对 env allowlist/skills 下载限制有配置口。  
扣分：Project token 明文入库；Role initScript 执行等同 RCE，需要更强的权限/审计/隔离策略（例如 RBAC、审计日志、签名/白名单、最小权限 token）。

10) 开发者体验（DX）：10/10  
证据：pnpm workspace、`pnpm dev`、Docker compose、Prisma migrate deploy 自动化、文档与 runbook 齐全。

Top 改进建议（按影响/成本排序）：
1. 给高危能力加“硬闸”：token 加密/脱敏、initScript/skills 的审批与审计、默认最小权限模板（中成本，高收益）
2. 增加最小 e2e：起 DB+backend+proxy（可 mock agent），覆盖“start run→event→create pr（stub）”关键链路（中成本，高收益）
3. 拆分 `acpTunnel.ts`：按“open/prompt/control/persist/chunk-buffer”分模块，并补单测（低到中成本，中收益）

---

## 09. 附录：关键文件/符号速查

入口点：
- `backend/src/index.ts:416`（listen）
- `acp-proxy/src/runProxyCli.ts:37`（CLI 主入口）
- `frontend/src/App.tsx`（路由与权限）

关键路由：
- `backend/src/routes/issues.ts:150`：`POST /api/issues/:id/start`
- `backend/src/routes/runs.ts`：`POST /api/runs/:id/prompt`、`POST /api/runs/:id/create-pr`、`POST /api/runs/:id/merge-pr`

关键模块：
- `backend/src/modules/runs/startIssueRun.ts:66`（Run 启动/初始化）
- `backend/src/modules/acp/acpTunnel.ts:69` / `backend/src/modules/acp/acpTunnel.ts:451`（ACP 隧道）
- `backend/src/websocket/gateway.ts`（/ws/agent + /ws/client）
- `acp-proxy/src/handlers/handleAcpOpen.ts:12`（sandbox/agent 启动与 skills 挂载）
- `frontend/src/components/RunConsole.tsx`（事件流渲染）
