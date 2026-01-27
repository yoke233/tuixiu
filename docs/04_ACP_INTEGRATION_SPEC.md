# ACP 协议集成规范（当前仓库实现）

本文档说明本仓库如何把 ACP（Agent Client Protocol）接入到 Web 看板：通过本地 `acp-proxy/` 把 **WebSocket** 与 **ACP(JSON-RPC/NDJSON over stdio)** 桥接起来，驱动本机的 ACP agent（默认 `npx --yes @zed-industries/codex-acp`）。

关键结论（务必先读）：

- **Proxy 实现语言**：Node.js + TypeScript（见 `acp-proxy/`），旧版 Go/Python 方案已移除
- **Session 复用优先**：Run 维度持久化 `Run.acpSessionId`；proxy 优先 `session/load`（若 agent 支持），避免“新建会话导致上下文丢失”
- **会话丢失降级**：确认为 session 失效时才新建，并注入后端拼装的 `context`（Issue 信息 + 对话节选）
- **输出更像 CLI**：proxy 做 chunk 聚合，前端再做二次合并与工具事件折叠，减少逐字与闪动

官方文档：

- https://agentclientprotocol.com/protocol/session-setup
- https://agentclientprotocol.com/protocol/session-modes

---

## 1. ACP 协议概述

ACP（Agent Client Protocol）是基于 JSON-RPC 2.0 的协议，常见传输方式为 stdio（NDJSON：每行一个 JSON）。

本仓库的链路：

```
[Web UI] ⇄ (ws/client) ⇄ [Orchestrator backend] ⇄ (ws/agent) ⇄ [acp-proxy] ⇄ (stdio/NDJSON) ⇄ [ACP agent 子进程(按 Run 隔离)]
```

ACP session 是“一段对话/线程”的上下文载体。要跨进程重启恢复对话，必须依赖 `session/load`，且前提是 agent 在 `initialize` 响应里声明支持 `loadSession`。

---

## 2. ACP 消息形态（速览）

### 2.1 初始化

proxy 会为每个 Run 启动独立的 agent 子进程（cwd=该 Run 的 worktree/workspace），并在启动后先发起 `initialize`，确认协议版本与能力（尤其是 `agentCapabilities.loadSession`）。

### 2.2 Session 建立/恢复

- 新会话：`session/new { cwd, mcpServers }` → `{ sessionId }`
- 旧会话恢复（可选）：`session/load { sessionId, cwd, mcpServers }` → agent 重放历史 `session/update`

### 2.3 Prompt 与流式更新

- `session/prompt`：发送用户/系统提示（本仓库只用 `text` content）
- `session/update`：agent 推送流式 chunk / tool_call / plan 等事件

---

## 3. ACP Proxy（Node/TypeScript）实现要点

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────┐
│              ACP Proxy (Node/TypeScript)            │
│                                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │  WebSocket Client                              │ │
│  │  - connect/reconnect (/ws/agent)               │ │
│  │  - heartbeat                                   │ │
│  │  - handle execute_task / prompt_run            │ │
│  └────────┬──────────────────────────────────────┘ │
│           │                                         │
│           ↓                                         │
│  ┌───────────────────────────────────────────────┐ │
│  │  Session Router                                │ │
│  │  - runId ↔ (bridge/process/sessionId) 映射      │ │
│  │  - session/load（可选）                         │ │
│  │  - chunk 聚合                                   │ │
│  └────────┬──────────────────────────────────────┘ │
│           │                                         │
│           ↓                                         │
│  ┌───────────────────────────────────────────────┐ │
│  │  ACP Bridge（@agentclientprotocol/sdk）        │ │
│  │  - 通过 Launcher/Sandbox 获取 stdio transport    │ │
│  │  - ndJsonStream：stdio/NDJSON                   │ │
│  │  - initialize/session/new/session/load/prompt   │ │
│  └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.2 代码入口与职责

- `acp-proxy/src/index.ts`
  - WebSocket 连接与重连、心跳
  - 处理 `execute_task` / `prompt_run`
  - 维护 `runId → (bridge/agent 子进程, sessionId)` 的运行态映射（每个 Run 独立 cwd/worktree）
  - 对 `agent_message_chunk` 做缓冲聚合（减少 UI 抖动）
  - 使用 `Semaphore` 限制并发 Run
- `acp-proxy/src/acpBridge.ts`
  - 通过 `AgentLauncher` 获取 agent 的 stdio transport
  - `@agentclientprotocol/sdk`：`ClientSideConnection` + `ndJsonStream`
  - 提供 `ensureInitialized/newSession/loadSession/prompt`
- `acp-proxy/src/launchers/*`：Agent 启动抽象（Launcher），便于未来切换不同运行方式
- `acp-proxy/src/sandbox/*`：Sandbox 抽象（当前实现 `HostProcessSandbox`，内置 Windows `cmd.exe /c` shim，避免 `spawn npx ENOENT`）
- `acp-proxy/src/config.ts`：加载 `config.json` 并用 zod 校验
- `acp-proxy/src/types.ts`：WS 消息类型

### 3.3 Session 生命周期（重点）

#### 3.3.1 Run 与 ACP session 的关系

- Run 是业务实体（后端/数据库）
- ACP session 是 agent 的对话上下文
- 本仓库约定：**Run 尽量绑定一个可复用的 ACP session**，其 id 持久化在 `Run.acpSessionId`

#### 3.3.2 首轮执行（execute_task）

后端在 `POST /api/issues/:id/start` 时：

1. 创建 Run + worktree + branch
2. 通过 WS 下发 `execute_task { run_id, prompt, cwd }`
3. proxy 在该 `cwd` 下创建 ACP session 并 prompt

注意：`execute_task.session_id` 仅为兼容字段，**不是 ACP sessionId**。

#### 3.3.3 继续对话（prompt_run）

用户在 Run 详情页发送消息会走 `POST /api/runs/:id/prompt`，后端会下发 `prompt_run`：

- `session_id`：来自 `Run.acpSessionId`（若已有）
- `context`：后端从 Issue + Events 中拼装的上下文（见 `backend/src/services/runContext.ts`）
- `cwd`：Run 对应的 worktree 路径（见 `Run.workspacePath`）

proxy 收到后：

1. 若本进程第一次见到该 `session_id`，且 agent 支持 `loadSession`：尝试 `session/load`
2. `session/load` 失败：**不立即新建 session**（避免无声换会话）；继续尝试 `session/prompt`
3. 若 prompt 明确报 session 不存在/无效：新建 session，并把 `context` 注入到 prompt 中降级恢复

### 3.4 Chunk 聚合（减少逐字/闪动）

agent 的 `agent_message_chunk` 可能非常细。proxy 会按 session 维度缓冲：

- 遇到换行符
- 或缓冲长度达到阈值
- 或距离上次 flush 超过阈值

才将 chunk 转发给后端，显著减少事件数量。

前端仍会进行二次合并与 tool_call 折叠（见 `frontend/src/components/RunConsole.tsx`）。

---

## 4. Orchestrator WebSocket 接口（当前实现）

端点：

- Agent（proxy）连接：`ws://localhost:3000/ws/agent`
- Web UI 连接：`ws://localhost:3000/ws/client`

消息协议（以代码为准：`backend/src/websocket/gateway.ts`、`acp-proxy/src/types.ts`）：

| 方向           | type             | 说明                | 最小 Payload |
| -------------- | ---------------- | ------------------- | ----------- |
| Agent → Server | `register_agent` | 注册/上线           | `{agent:{id,name,max_concurrent?,capabilities?}}` |
| Server → Agent | `register_ack`   | 注册确认            | `{success:true}` |
| Agent → Server | `heartbeat`      | 心跳                | `{agent_id,timestamp?}` |
| Server → Agent | `execute_task`   | 启动 Run（首轮执行） | `{run_id,prompt,cwd?}` |
| Server → Agent | `prompt_run`     | 继续对话（同 Run）/断线重连恢复 | `{run_id,prompt,session_id?,context?,cwd?,resume?}` |
| Server → Agent | `cancel_task`   | 取消 Run（ACP session/cancel） | `{run_id,session_id?}` |
| Server → Agent | `session_cancel` | 手动暂停/关闭 ACP session（ACP session/cancel） | `{run_id,session_id?}` |
| Agent → Server | `agent_update`   | 事件流转发           | `{run_id,content:any}` |

服务器关键行为摘要：

- `register_agent`：upsert `Agent`，置 `online`，回 `register_ack`；并**自动下发**该 agent 仍处于 `running` 状态的 Run（`prompt_run{resume:true,...}`），用于断线重连/重启后的恢复
- `heartbeat`：刷新 `Agent.lastHeartbeat`
- `agent_update`：
  - 落库 `Event`（`source=acp`，`type=acp.update.received`）
  - 若 `content.type === "session_created"`：更新 `Run.acpSessionId`
  - 若 `content.type === "prompt_result"`：推进 `Run/Issue` 状态并回收 agent load
  - 推送给 Web UI（`ws/client`）

补充：

- `session_cancel` 目前用于两处：
  - Run 详情页的“暂停 Agent”（`POST /api/runs/:id/pause`）
  - 管理页 “ACP Sessions” 的手动清理（`GET /api/admin/acp-sessions` / `POST /api/admin/acp-sessions/cancel`）

---

## 5. 典型消息流（当前实现）

### 5.1 Issue 进入需求池 → 启动 Run → 输出事件流

```
1) Web UI:  POST /api/issues               -> Issue(pending)
2) Web UI:  POST /api/issues/:id/start     -> Run(running) + worktree
3) backend: WS -> proxy execute_task       -> {run_id,prompt,cwd}
4) proxy:   ACP session/new + prompt       -> session/update stream
5) proxy:   WS -> backend agent_update     -> Event persisted
6) backend: WS -> web ui event_added       -> RunConsole 实时展示
7) prompt_result: backend 推进状态         -> Run(completed), Issue(reviewing)
```

### 5.2 同一 Run 继续对话（复用 session）

```
1) Web UI: POST /api/runs/:id/prompt
2) backend: buildContextFromRun()
3) backend: WS -> proxy prompt_run {session_id, context, cwd}
4) proxy: maybe session/load -> prompt -> stream updates
```

---

## 6. 测试与调试（当前仓库）

单元测试（Vitest）：

```powershell
pnpm test
pnpm test:coverage
```

单独跑 proxy：

```powershell
cd acp-proxy
pnpm test
pnpm dev
```

调试建议：

- 将 `acp-proxy/config.json` 的 `mock_mode` 设为 `true`，先验证 WS 链路
- Windows 调本地 API：使用 `curl.exe --noproxy 127.0.0.1 ...`

---

## 7. 常见问题（FAQ）

### Q1: `spawn npx ENOENT`

Windows 下 `npx` 可能是 `*.cmd`，直接 `spawn("npx")` 会找不到可执行文件。proxy 已在 `HostProcessSandbox` 内置 `cmd.exe /c` shim；若仍失败：

- `where.exe npx`
- 检查 `acp-proxy/config.json` 的 `agent_command`

### Q2: `session/load` 失败或 session 丢失

可能原因：

- agent 不支持 `loadSession`
- session 在 agent 侧已丢失

策略：

- `load` 失败不立刻新建；继续尝试 prompt
- prompt 明确报 session 丢失时才新建，并注入 `context`

---

## 8. 性能优化要点

- proxy chunk 聚合 + 前端二次合并：减少事件条数与 UI 频繁重渲染
- 前端对事件做上限裁剪，避免长会话渲染过慢（见 `frontend/src/pages/IssueDetailPage.tsx`）

---

## 9. 部署清单（本仓库）

### 9.1 Proxy 配置

检查 `acp-proxy/config.json`：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `cwd`: repo 根目录（或允许被 `cwd` 覆盖到 worktree）
- `sandbox.provider`: 默认 `host_process`（`boxlite_oci` 预留）
- `pathMapping`: 可选（仅当你在 WSL 内运行 proxy 且后端传入 Windows 路径时使用）
- `agent_command`: 默认 `["npx","--yes","@zed-industries/codex-acp"]`
- `agent.max_concurrent`: 与期望并发一致

### 9.2 运行方式

```powershell
cd acp-proxy
pnpm build
pnpm start
```

### 9.3 连通性检查

```powershell
wscat -c ws://localhost:3000/ws/agent
```

---

## 下一步

- GitLab：阅读 `docs/05_GITLAB_INTEGRATION.md`（GitLab 侧称 MR，本系统统一称 PR）
- GitHub：阅读 `backend/src/integrations/github.ts` 与 `backend/src/services/runReviewRequest.ts`
