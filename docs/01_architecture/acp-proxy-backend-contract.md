---
title: "acp-proxy 与后端交互契约（WS /ws/agent）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-02-03"
---

# acp-proxy 与后端交互契约（WS /ws/agent）

本文档聚焦 **acp-proxy 与 orchestrator backend 的交互**：连接方式、鉴权、消息类型、事件落库与 UI 广播语义、以及常见故障的可观测性。

如果文档与代码不一致，以代码为准（并请更新本文档）。关键入口：

- Proxy：`acp-proxy/src/runProxyCli.ts`、`acp-proxy/src/runs/runRuntime.ts`、`acp-proxy/src/types.ts`
- Backend：`backend/src/websocket/gateway.ts`、`backend/src/modules/acp/acpTunnel.ts`

## 1. 术语与边界

- **Backend / Orchestrator**：负责 HTTP API、Run 生命周期、DB 持久化、以及 WS 网关。
- **Proxy（acp-proxy）**：连接 backend 的 `/ws/agent`，在本机/容器里启动 ACP Agent，并将 ACP JSON-RPC/NDJSON 与 backend 的 WS 协议桥接。
- **ACP Agent**：实现 ACP 协议（JSON-RPC 2.0），通过 stdio/NDJSON 与 proxy 通讯。
- **Run**：一次执行单元（DB `Run`）；通常对应一个 sandbox 实例 + 一个 agent 进程。
- **Session**：ACP 的会话上下文（`sessionId`）；`Run.acpSessionId` 存储当前会话 ID。

本仓库明确区分两条信号线：

- `acp_update`：只承载 **来自 ACP 协议侧** 的更新（`session/update` 原样转发 + 少量“由 RPC 响应合成的 ACP 语义更新”，例如 `config_option_update`）。
- `proxy_update`：只承载 **proxy 自产/基础设施信号**（init 输出、sandbox/transport 状态、权限请求、`[proxy:error]` 等）。

## 2. 传输层与鉴权

### 2.1 Backend <-> Proxy：WebSocket `/ws/agent`

- 连接地址：`ws://<backend-host>/ws/agent`
- 鉴权方式：proxy 连接时带 `Authorization: Bearer <token>` header。
  - backend 会校验 token payload，要求 `payload.type === "acp_proxy"`（见 `backend/src/websocket/gateway.ts`）。
  - proxy 的 token 来源：
    - 直接配置：`acp-proxy/config.toml` 的 `auth_token`
    - 或注册换取：配置 `register_url` + `bootstrap_token`，proxy 会先 POST register 获取 token（见 `acp-proxy/src/runProxyCli.ts`）。

### 2.2 Proxy <-> Agent：stdio/NDJSON（JSON-RPC 2.0）

proxy 为每个 Run 维护独立的 Agent 子进程，通过 stdio/NDJSON 通讯：

- Request/Response：JSON-RPC `initialize`、`session/new`、`session/load`、`session/prompt`、`session/set_*` 等
- Notification：`session/update`（流式输出/工具调用/模式与选项更新等）

## 3. 消息契约：Backend -> Proxy（Server -> Agent）

以 `acp-proxy/src/types.ts` 与 `backend/src/modules/acp/acpTunnel.ts` 为准。

### 3.1 acp_open

目的：确保 sandbox 实例与 agent 进程就绪，并完成 ACP initialize。

最小字段：

```json
{ "type": "acp_open", "run_id": "<uuid>" }
```

常见字段：

- `instance_name`：sandbox 实例名（默认 `tuixiu-run-<runId>`）
- `keepalive_ttl_seconds`：实例保活 TTL
- `init`：初始化脚本与环境（由 backend 构造）
  - `init.script`：workspace 初始化/role init 等（在 agent 启动前执行，取决于 sandbox.agentMode/provider）
  - `init.env`：注入 `TUIXIU_*` 等运行变量
  - `init.agentInputs`：技能/挂载等输入（由 proxy 负责落地）

预期响应：

- proxy -> backend：`acp_opened { run_id, ok, error? }`
- 并伴随持续的 `proxy_update`（init_step/text/sandbox_instance_status/...）

### 3.2 prompt_send

目的：发起一次 ACP “对话回合”。

核心字段：

- `prompt_id`：本次回合的 request id（backend 用于关联结果）
- `session_id`（可选）：希望复用的会话；为空则 proxy 会 `session/new`
- `context`（可选）：后端构造的恢复上下文/系统提示
- `prompt`：ACP content blocks（本仓库主要使用 `text`）
- `timeout_ms`（可选）：回合超时

预期响应：

- proxy -> backend：`prompt_result { run_id, prompt_id, ok, session_id?, stop_reason?, error? }`
- 中间过程：proxy 会把 agent 的 `session/update` 通过 `acp_update` 持续推送给 backend。

### 3.3 acp_close

目的：关闭 run 对应的 agent/transport，释放运行态。

```json
{ "type": "acp_close", "run_id": "<uuid>" }
```

### 3.4 session 控制类（取消/切换/配置）

这些消息由 backend 触发（来源可能是 UI 控制面板或自动化策略），proxy 执行 ACP RPC 后回 `session_control_result`：

- `session_cancel { run_id, control_id, session_id }` -> `session_control_result`
- `session_set_mode { run_id, control_id, session_id, mode_id }` -> `session_control_result`
- `session_set_model { run_id, control_id, session_id, model_id }` -> `session_control_result`
- `session_set_config_option { run_id, control_id, session_id, config_id, value }` -> `session_control_result`

### 3.5 session_permission（权限请求回执）

当 proxy 产生 `proxy_update(permission_request)` 后，backend 会把用户选择通过该消息回传给 proxy，由 proxy 继续把选择传递给 agent（具体交互由 `AcpClientFacade`/permissionAsk 实现）：

```json
{
  "type": "session_permission",
  "run_id": "<uuid>",
  "session_id": "<sessionId>",
  "request_id": "<id>",
  "outcome": "selected",
  "option_id": "<optionId>"
}
```

### 3.6 sandbox_control（基础设施操作）

用于 stop/remove/gc/git_push 等 sandbox 侧控制，proxy 负责执行并回 `sandbox_control_result`（含 stdout/stderr/code/signal）。

## 4. 消息契约：Proxy -> Backend（Agent -> Server）

### 4.1 register_agent / heartbeat

- proxy 连接建立后应先发送 `register_agent` 完成上线：
  - `agent.id`：proxyId（DB `Agent.proxyId`）
  - `agent.capabilities`：能力透传（用于调度/展示）
- 心跳：`heartbeat { agent_id, timestamp? }`

backend 侧会：

- `register_agent`：upsert Agent 并标记 online，然后回 `register_ack`
- `heartbeat`：刷新 `Agent.lastHeartbeat`

### 4.2 acp_opened

```json
{ "type": "acp_opened", "run_id": "<uuid>", "ok": true }
```

用于让 backend 的 `acpTunnel.ensureOpen` 解锁后续 prompt。

### 4.3 acp_update（ACP 语义更新）

这是最关键的“ACP 信号线”。proxy 会：

- 原样转发 agent 的 `session/update` 通知（method=`session/update`）
- 在少数情况下从 RPC 响应“合成”ACP 语义更新（例如 `session/new`/`session/set_config_option` 的返回包含 `configOptions` 但 agent 不发通知）

统一消息形态：

```json
{
  "type": "acp_update",
  "run_id": "<uuid>",
  "prompt_id": "<uuid-or-null>",
  "session_id": "<sessionId-or-null>",
  "update": { "...": "raw ACP update" }
}
```

目前 backend 侧依赖以下语义（由 `backend/src/modules/acp/acpTunnel.ts` 处理与落库）：

- `update.content.type = "session_created"`
  - 用于尽早写入 `Run.acpSessionId`（仅当为空时）
- `update.content.type = "session_state"`
  - 用于更新 `Run.metadata.acpSessionState`（activity/inFlight/currentModeId/...）
- `update.sessionUpdate = "config_option_update"`
  - 用于保存 `configOptions` 到 `Run.metadata.acpSessionState.configOptions`（并派生 currentModeId/currentModelId）

说明：UI 侧还会收到 backend 广播的 `acp.prompt_update`（见第 5 节），其 payload 基本等价于这里的 `acp_update`。

补充：proxy 目前只会把 **ACP `session/update`** 这类通知转换为 `acp_update` 上报；
`$/cancel_request` 属于 proxy 内部的 permission request 取消机制（用于撤销待确认的 tool call），不会转发给 backend；
其他未识别的 JSON-RPC 通知当前仅记录日志（如未来需要可观测性/审计，可考虑同样纳入 `proxy_update` 或扩展 `acp_update`）。

### 4.4 proxy_update（proxy 自产/基础设施信号）

统一形态：

```json
{ "type": "proxy_update", "run_id": "<uuid>", "content": { "...": "proxy signal" } }
```

常见 `content.type`（非穷举）：

- `text`：console 文本（包括 `[init]`、`[agent:stderr]`、`[proxy:error]` 前缀）
- `init_step` / `init_result`：init script 阶段与结果
- `sandbox_instance_status`：实例状态心跳/错误（provider/runtime/last_seen_at/last_error）
- `transport_connected` / `transport_disconnected`：agent transport 连接状态（以及 agent_exit 的 code/signal）
- `permission_request`：需要用户确认的 tool call（request_id/session_id/prompt_id/tool_call/options）

### 4.5 prompt_result / session_control_result

用于完成一次 `prompt_send` 或 session control：

- `prompt_result { run_id, prompt_id, ok, session_id?, stop_reason?, error? }`
- `session_control_result { run_id, control_id, ok, error? }`

### 4.6 sandbox_control_result / inventory / acp_exit（运维信号）

- `sandbox_control_result`：sandbox_control 的回执
- `sandbox_inventory` / `workspace_inventory`：对账与 GC/删除追踪
- `acp_exit`：agent 进程退出（backend 会落库为 `sandbox.acp_exit` 并更新 Run/SandboxInstance 状态）

## 5. Backend 侧：落库与广播语义

### 5.1 /ws/agent 收消息入口

入口：`backend/src/websocket/gateway.ts`（`handleAgentConnection`）。

关键行为：

- 收到 `acp_update`：
  - 立刻向 `/ws/client` 广播：`{ type:"acp.prompt_update", run_id, prompt_id, session_id, update }`
  - 同时交给 `acpTunnel.handlePromptUpdate(...)`：
    - chunk 合并与落库：写 `Event(source="acp", type="acp.update.received", payload={type:"session_update", session, update})`
    - Run 状态派生：更新 `Run.acpSessionId` 与 `Run.metadata.acpSessionState`
    - 并广播 `event_added`（对应落库后的 Event）
- 收到 `proxy_update`：
  - 写 `Event(source="acp", type="acp.update.received", payload=<content>)`
  - 广播 `event_added`
  - 并对部分基础设施信号更新 `Run.sandbox*` / `Run.metadata.acpTransport` / init 失败状态等

### 5.2 UI 侧为什么会“看到两种流”

UI 通常会同时看到：

- **即时流**：`acp.prompt_update`（低延迟，用于 console 实时渲染）
- **持久化流**：`event_added`（来自 DB 的事件，可能因 chunk 合并/flush 有轻微延迟）

因此如果 UI 只盯 `GET /api/runs/:id/events`，可能会感觉“卡住”；正确做法是消费 WS 的实时流。

## 6. 超时、缓冲与顺序保证（要点）

- `acp_open` 默认超时受 `ACP_OPEN_TIMEOUT_MS` 影响（默认 300000ms）
- `prompt_send` 默认超时受 `ACP_PROMPT_TIMEOUT_MS` 影响（默认 3600000ms）
- chunk 合并：`backend/src/modules/acp/acpTunnel.ts` 对 `*_chunk` 文本会 buffer/flush（默认 800ms 或累计 16000 chars 触发 flush）

## 7. 可观测性与故障定位（推荐做法）

目标：任何失败都应让用户在 UI console/事件列表里看到“为什么”。

建议检查顺序：

1. 看 `proxy_update.text` 是否出现 `[proxy:error] ...`（proxy handler 失败时应立刻发）
2. 看 `proxy_update.text` 是否出现 `[agent:stderr] ...`（例如 `execvp ... No such file or directory`）
3. 看 `proxy_update.transport_disconnected` / `sandbox.acp_exit`（agent_exit 的 code/signal）
4. 看 `proxy_update.sandbox_instance_status.last_error`（sandbox provider 层错误）

常见问题示例：

- `bwrap: execvp npx ... No such file or directory`
  - 说明 agent_command 指向的可执行文件在 sandbox 里不存在；优先使用预装 `codex-acp` 的镜像并配置 `agent_command=["codex-acp"]`。

## 8. 变更指南（新增/修改消息时怎么改）

当你要新增一个消息类型或增强 payload：

1. Proxy：增加/更新 handler（`acp-proxy/src/handlers/*`）并在必要时补齐 `acp-proxy/src/types.ts` 定义
2. Backend：在 `backend/src/websocket/gateway.ts` 增加消息解析与分发；如属于 ACP 语义，优先接入 `backend/src/modules/acp/acpTunnel.ts`
3. 测试：补 `acp-proxy/src/handlers/*.test.ts` 与 `backend/test/websocket/gateway.test.ts`
4. 文档：更新本文档（以及必要时更新 `docs/00_overview/index.md` 的入口链接）
