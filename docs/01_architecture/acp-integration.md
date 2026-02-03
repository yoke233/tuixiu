---
title: "ACP 协议集成规范（当前仓库实现）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-31"
---

# ACP 协议集成规范（当前仓库实现）

本文档说明本仓库如何把 ACP（Agent Client Protocol）接入到 Web 看板：通过本地 `acp-proxy/` 把 **WebSocket** 与 **ACP(JSON-RPC/NDJSON over stdio)** 桥接起来，驱动本机的 ACP agent（默认 `codex-acp`）。

补充：如果你要看“proxy 与后端之间 WS /ws/agent 的消息契约、事件落库与广播语义”，请读：`docs/01_architecture/acp-proxy-backend-contract.md`。

关键结论（务必先读）：

- **Proxy 实现语言**：Node.js + TypeScript（见 `acp-proxy/`），旧版 Go/Python 方案已移除
- **当前桥接模式**：后端不再直接转发 ACP JSON-RPC；由 `acp-proxy` 负责 `initialize`/`session/*`，后端只下发 `acp_open` / `prompt_send` / `sandbox_control` / `acp_close` 等高层指令

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

proxy 会为每个 Run 启动独立的 agent 子进程（cwd=该 Run 的 workspace；`workspaceMode=git_clone` 时为 `/workspace/run-<runId>`），并在启动后先发起 `initialize`，确认协议版本与能力（尤其是 `agentCapabilities.loadSession`）。

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
│  │  - handle acp_open / prompt_send / acp_close   │ │
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

- `acp-proxy/src/index.ts`：CLI 入口（不放业务逻辑）
- `acp-proxy/src/proxyCli.ts`
  - WebSocket 连接与重连、心跳
  - 处理 `acp_open` / `prompt_send` / `acp_close`（由 proxy 负责 `initialize`/`session/*`，后端不直接转发 ACP JSON-RPC）
  - 维护 `runId → ACP stream` 的运行态映射
  - 沙箱启动模式：`sandbox.agentMode=exec|entrypoint`（`entrypoint` 下如提供 `acp_open.init.script` 会在 agent 启动前执行）
- `acp-proxy/src/launchers/*`：Agent 启动抽象（Launcher），便于未来切换不同运行方式
- `acp-proxy/src/platform/*`：平台抽象（选择 provider/runtime、路径方言与 cwd 映射、session 默认策略、workspace 语义等）
- `acp-proxy/src/sandbox/*`：Sandbox 抽象（当前实现 `boxlite_oci` / `container_oci` / `host_process`）
- `acp-proxy/src/config.ts`：加载 `config.toml`/`config.json` 并用 convict 校验
- `acp-proxy/src/types.ts`：WS 消息类型

### 3.3 Session 生命周期（当前实现）

Session 的创建/复用/恢复由 `acp-proxy` 托管：

- `prompt_send` 未提供 `session_id`：proxy 会 `session/new`
- `prompt_send` 提供 `session_id`：若 agent 支持 `loadSession`，proxy 会尝试 `session/load`

---

## 4. Orchestrator WebSocket 接口（当前实现）

端点：

- Agent（proxy）连接：`ws://localhost:3000/ws/agent`
- Web UI 连接：`ws://localhost:3000/ws/client`

消息协议（以代码为准：`acp-proxy/src/types.ts`（Server → Agent）与 `backend/src/websocket/gateway.ts`（Agent → Server））：

| 方向           | type             | 说明               | 最小 Payload                                      |
| -------------- | ---------------- | ------------------ | ------------------------------------------------- |
| Agent → Server | `register_agent` | 注册/上线          | `{agent:{id,name,max_concurrent?,capabilities?}}` |
| Agent → Server | `heartbeat`      | 心跳               | `{agent_id,timestamp?}`                           |
| Server → Agent | `acp_open`       | 打开/启动 ACP 进程 | `{run_id,cwd?,init?}`                             |
| Server → Agent | `prompt_send`    | 发起一次对话回合   | `{run_id,prompt_id,session_id?,context?,prompt}`   |
| Server → Agent | `acp_close`      | 关闭 Run           | `{run_id}`                                        |
| Agent → Server | `acp_update`     | ACP `session/update` 转发（含合成的 config_option_update） | `{run_id,session_id?,prompt_id?,update:any}` |
| Agent → Server | `proxy_update`   | Proxy 自产事件（init/transport/sandbox/proxy:error 等） | `{run_id,content:any}` |
| Server → Agent | `sandbox_control` | 管理/清理指令（stop/remove/gc/remove_workspace 等） | `{action,run_id?,instance_name?,expected_instances?,dry_run?,gc?,request_id?}` |
| Agent → Server | `sandbox_control_result` | 回执（含 request_id） | `{ok,request_id?,error?}` |
| Agent → Server | `sandbox_inventory` | 上报实例清单/缺失/删除（用于对账与追踪删除） | `{inventory_id,captured_at?,instances?,missing_instances?,deleted_instances?,deleted_workspaces?}` |
| Agent → Server | `workspace_inventory` | 上报 workspace 列表（估算/删除后对账） | `{inventory_id,captured_at,workspace_mode,workspaces:[...]}` |

命名约定（重要）：

- proxy ⇄ backend：使用下划线命名的 WS 消息类型（例如 `acp_update` / `proxy_update`）
- backend → Web UI（`/ws/client`）：使用点分层的事件名（例如 `acp.update`）

`/ws/client` 侧的常用事件：

- `event_added`：DB 落库后的事件（权威流）
- `acp.update`：低延迟的 ACP update 直出（payload 与 `/ws/agent` 的 `acp_update` 基本等价）

服务器关键行为摘要：

- `register_agent`：upsert `Agent`，置 `online`
- `heartbeat`：刷新 `Agent.lastHeartbeat`
- `acp_update`：由 `backend/src/modules/acp/acpTunnel.ts` 负责落库/合并并推送给 Web UI（`ws/client`）
  - Event 形态：`{ type:"session_update", session:<sessionId>, update:<raw update> }`
  - chunk 合并：对 `*_chunk` 文本做 buffer/flush（减少 DB 写压力与 UI 噪声）
  - Run 状态派生：从 `update.content`/`update.sessionUpdate` 派生并写入 `Run.acpSessionId` 与 `Run.metadata.acpSessionState`
    - `update.content.type=session_created`：尽早写入 `Run.acpSessionId`
    - `update.content.type=session_state`：更新 `metadata.acpSessionState`（activity/inFlight/currentModeId/...）
    - `update.sessionUpdate=config_option_update`：保存 `configOptions`，供前端渲染 mode/model/options 控件
- `proxy_update`：由 `backend/src/websocket/gateway.ts` 负责落库并推送给 Web UI（`ws/client`）；用于 init/transport/sandbox/proxy:error 等基础设施信号

补充：

- `session_cancel` 目前用于两处：
  - Run 详情页的“暂停 Agent”（`POST /api/runs/:id/pause`）
  - 管理页 “ACP Sessions” 的手动清理（`GET /api/admin/acp-sessions` / `POST /api/admin/acp-sessions/cancel`）

---

## 4.1 Inventory / GC / Workspace 语义（本仓库新增的“资源管理”层）

为了止血“遗留实例/工作区膨胀”与“删除不可追踪”，本仓库在 ACP 之外引入了 **inventory + reconciler + workspace manager** 的高层协议：

- **Inventory（清单）**：`acp-proxy` 周期性/按需上报 `sandbox_inventory` / `workspace_inventory`
- **Reconcile（对账）**：后端把 DB 中“预期存在”的实例列表作为 `expected_instances` 下发给 proxy；proxy 计算出 `missing_instances`（预期有但实际无）
- **Delete reporting（删除上报）**：proxy 在 remove/gc/remove_workspace 后通过 `deleted_instances` / `deleted_workspaces` 明确上报“已删除”，后端据此把记录标记为 deleted（而不是“神秘消失”）

关键约定：

- `workspaceMode=mount`：宿主机目录 `workspaceHostRoot/run-<runId>`
- `workspaceMode=git_clone`：guest 内目录 `/workspace/run-<runId>`（删除 workspace 只删该子目录，不再粗暴清空 `/workspace`）

## 5. 典型消息流（当前实现）

### 5.1 启动 Run → 输出事件流

```
1) backend: WS -> proxy acp_open           -> {run_id,instance_name?,init?}
2) proxy:   启动 sandbox/agent，并完成 initialize
3) backend: WS -> proxy prompt_send        -> {run_id,prompt_id,session_id?,context?,prompt}
4) proxy:   session/new|load + session/prompt，并回传 acp_update / prompt_result（并可能伴随 proxy_update）
```

### 5.2 关闭 Run

```
1) backend: WS -> proxy acp_close          -> {run_id}
2) proxy:   关闭 stdio/transport 并清理 run 状态
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

- 将 `acp-proxy/config.toml` 的 `mock_mode` 设为 `true`，先验证 WS 链路
- Windows 调本地 API：使用 `curl.exe --noproxy 127.0.0.1 ...`

---

## 7. 常见问题（FAQ）

### Q1: `docker/podman/nerdctl` 不可用

容器模式依赖宿主机可用的容器运行时。请确认 `sandbox.provider=container_oci` 时，对应 runtime 已安装且可执行。

---

## 8. 性能优化要点

- 前端对事件做二次合并：减少事件条数与 UI 频繁重渲染
- 前端对事件做上限裁剪，避免长会话渲染过慢（见 `frontend/src/pages/IssueDetailPage.tsx`）

---

## 9. 部署清单（本仓库）

### 9.1 Proxy 配置

检查 `acp-proxy/config.toml`：

- `orchestrator_url`: `ws://localhost:3000/ws/agent`
- `sandbox.provider`: `boxlite_oci` 或 `container_oci`
- `sandbox.image`: agent 镜像
- `sandbox.runtime`: 容器运行时（仅 `provider=container_oci` 使用）
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

- GitLab：阅读 `docs/03_guides/gitlab-integration.md`（GitLab 侧称 MR，本系统统一称 PR）
- GitHub：阅读 `backend/src/integrations/github.ts` 与 `backend/src/services/runReviewRequest.ts`
