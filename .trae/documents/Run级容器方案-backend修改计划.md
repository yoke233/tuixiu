# Run 级容器方案：backend 修改计划（控制面）

目标：给负责 backend 的开发同学一份可直接开工的实施说明。

## 0. 背景与总体目标

我们要支持“backend 与 workspace/容器不在同一台机器”的部署形态。

这意味着 backend 必须从“执行面”（本机跑 git/读写 workspace/跑命令）退化为“控制面”（调度、审计、对外 API、落库）。

本方案的核心收敛点：

- 每个 Run 对应一个容器（强隔离）
- `sandbox_instance_id = run_id`
- `instance_name` 在 backend 生成并持久化、并在 `acp_open` 下发给执行面
- 默认保活 TTL=1800s（30min），启动任务时 backend 可覆盖
- backend 能展示：每个 run 的容器名/状态/最后心跳/最近任务
- backend 能控制：inspect/ensure_running/stop/remove（通过 WS 下发给执行面，不在 backend 本地 docker）

## 1. 当前代码现状（需要理解的事实）

### 1.1 ACP Client 现在在 backend

当前 backend 的 [acpTunnel.ts](file:///d:/xyad/tuixiu/backend/src/services/acpTunnel.ts) 充当 ACP Client：实现了 `fs/*`、`terminal/*`、`request_permission`。

在分布式（backend 不与 workspace 同机）时，这些方法不能继续在 backend 执行。

本阶段 backend 不要求立刻迁移所有执行逻辑（会在后续迭代迁移），但必须完成：

- Run 级容器的“控制面闭环”（固定 name + TTL + 状态落库 + 控制接口）
- WS 协议升级，为后续把执行逻辑迁出 backend 做铺垫

### 1.2 WebSocket 网关接入点

agent/proxy 侧的 WS 入口在 [gateway.ts](file:///d:/xyad/tuixiu/backend/src/websocket/gateway.ts)。

目前识别的消息有：`register_agent/heartbeat/acp_opened/acp_message/agent_update/branch_created`。

缺口：没有处理 `acp_exit`、没有结构化落库“容器状态”。

## 2. 数据模型（Prisma）修改

### 2.1 Run 增加字段（必须）

建议在 `Run` 模型新增：

- `sandboxInstanceName String?`：固定容器名（instance_name）
- `keepaliveTtlSeconds Int?`：默认 1800，可覆盖
- `sandboxStatus String?`：`creating|running|stopped|missing|error`
- `sandboxLastSeenAt DateTime?`
- `sandboxLastError String?`

约束：

- `sandboxInstanceName` 必须可预测且稳定，推荐：`tuixiu-run-${run.id}`（run.id 是 uuid，符合 docker name 约束，长度安全）。

对应位置：模型在 [schema.prisma](file:///d:/xyad/tuixiu/backend/prisma/schema.prisma)。

### 2.2 Event（可选增强）

若希望可审计每次容器状态变化，可在 event 表新增类型：

- `sandbox.status.changed`
- `sandbox.control.requested`

但 v1 可以先用 Run 字段承载状态即可。

### 2.3 SandboxInstance 表（推荐，用于“按 proxy 列出当前/历史容器”）

仅用 Run 表无法覆盖“孤儿容器/历史容器”的清理场景：容器可能存在，但 backend 没有对应 run 记录或 run 已归档。

建议新增 `SandboxInstance`（或同名表）：

- `id`（uuid）
- `proxyId`（当前注册的 acp-proxy 标识）
- `instanceName`（容器固定 name）
- `runId`（可空；能解析则关联）
- `provider` / `runtime`（可空）
- `status`（running/stopped/missing/error）
- `createdAt`（可空）
- `lastSeenAt`（必填）
- `lastError`（可空）

唯一性建议：`@@unique([proxyId, instanceName])`

用途：

- 后台直接按 proxyId 查询“当前/历史容器列表”
- 支持对孤儿容器发起 stop/remove

## 3. API 变更（启动任务时可传 TTL）

### 3.1 Start issue run

路由在 [issues.ts](file:///d:/xyad/tuixiu/backend/src/routes/issues.ts)。

现有 body：`{ agentId?, roleKey?, worktreeName? }`

新增：

- `keepaliveTtlSeconds?: number`（范围建议：60 ~ 86400；默认 1800）

落库规则：

- 创建 Run 时：
  - `sandboxInstanceName = tuixiu-run-${run.id}`
  - `keepaliveTtlSeconds = body.keepaliveTtlSeconds ?? 1800`
  - `sandboxStatus = creating`（或 null）

与实现点对齐：Run 创建逻辑目前在 [startIssueRun.ts](file:///d:/xyad/tuixiu/backend/src/services/startIssueRun.ts)。

## 4. WebSocket 协议升级（控制面闭环）

### 4.1 backend → acp-proxy：扩展 acp_open

当前 [acpTunnel.ts](file:///d:/xyad/tuixiu/backend/src/services/acpTunnel.ts) 下发 `acp_open` 仅含 `{run_id,cwd,init}`。

必须扩展为：

```json
{
  "type": "acp_open",
  "run_id": "<uuid>",
  "cwd": "<opaque-workspace-ref-or-path>",
  "init": { "script": "..." },
  "instance_name": "tuixiu-run-<run_id>",
  "keepalive_ttl_seconds": 1800
}
```

要求：

- `instance_name` 必填（backend 生成）
- `keepalive_ttl_seconds` 可选（backend 默认 1800，启动任务可覆盖）

### 4.2 acp-proxy → backend：容器状态上报

复用 `agent_update`，新增 `content.type = sandbox_instance_status`：

```json
{
  "type": "agent_update",
  "run_id": "<uuid>",
  "content": {
    "type": "sandbox_instance_status",
    "instance_name": "tuixiu-run-...",
    "provider": "container_oci",
    "runtime": "docker",
    "status": "running",
    "last_seen_at": "...",
    "last_error": null
  }
}
```

gateway.ts 处理逻辑（需要新增分支）：

- 更新 `Run.sandboxStatus/sandboxLastSeenAt/sandboxLastError`。
- 若 run 不存在，忽略或写系统日志。
- 建议对同一 run 做串行队列（gateway 里已有 enqueueRunTask 模式）。

### 4.3 acp-proxy → backend：acp_exit

新增处理 `acp_exit`：

```json
{ "type": "acp_exit", "run_id": "<uuid>", "instance_name": "...", "code": 1, "signal": null }
```

落库策略：

- 写 event（可选）
- 更新 Run：
  - `sandboxStatus = stopped`（或 error，按 code 判断）
  - `sandboxLastSeenAt = now`

注意：Run 的业务状态（running/failed/completed）不应被容器退出直接覆盖，除非明确该退出导致 run 失败（需要根据 run 是否仍在执行来判定）。

### 4.4 backend → acp-proxy：sandbox_control

新增 WS 消息：

```json
{ "type": "sandbox_control", "run_id": "<uuid>", "instance_name": "...", "action": "inspect" }
```

action: `inspect | ensure_running | stop | remove`

同时新增回包：`sandbox_control_result` 或通过状态上报回写。

### 4.5 acp-proxy → backend：sandbox_inventory（新增）

为满足“服务端获取某个注册的 acp-proxy 当前/历史容器清单，并允许清理”的需求，需要新增清单同步消息：

```json
{
  "type": "sandbox_inventory",
  "inventory_id": "<uuid>",
  "provider": "container_oci",
  "runtime": "docker",
  "captured_at": "2026-01-28T12:00:00.000Z",
  "instances": [
    {
      "instance_name": "tuixiu-run-<run_id>",
      "run_id": "<uuid>",
      "status": "running",
      "created_at": "2026-01-28T10:00:00.000Z",
      "last_seen_at": "2026-01-28T12:00:00.000Z"
    }
  ]
}
```

gateway.ts 需要新增处理分支：

- 将 `instances` upsert 到 `SandboxInstance`（按 proxyId+instanceName）
- 若 `run_id` 存在则写入关联；并可同步更新 Run 表中的 sandboxStatus/lastSeen

触发策略：

- proxy 成功注册后主动上报一次 inventory
- backend 管理接口也可以下发 `sandbox_control: report_inventory` 主动拉取

## 5. 后台管理接口（给 UI/运维使用）

目标：让后台可以查询与管控“某个 proxy 当前维护的各个容器”。

### 5.1 查询接口（读 DB 即可）

建议新增路由（示例）：

- `GET /api/admin/sandboxes?proxyId=<proxyId>&status=running&limit=200`

返回字段：

- `runId`
- `instanceName`
- `sandboxStatus`
- `sandboxLastSeenAt`
- `keepaliveTtlSeconds`
- `issueId/taskId/stepId`（用于快速定位业务）

实现方式（推荐）：

- 查询 `SandboxInstance` 表，保证能覆盖“孤儿容器/历史容器”
- 同时可 join Run/Issue 信息用于展示

实现方式（最低可用）：

- 直接查询 Run 表（只能覆盖有 run 记录的实例）

### 5.2 控制接口（写 WS 下发）

建议新增路由（示例）：

- `POST /api/admin/sandboxes/control`

body:

```json
{ "runId": "<uuid>", "action": "ensure_running" }
```

服务端逻辑：

1) 查 Run：取 `agent.proxyId` 与 `sandboxInstanceName`
2) 通过 `sendToAgent(proxyId, payload)` 下发：
   - `{ type: "sandbox_control", run_id, instance_name, action }`
3) 返回 `{ success: true }`（回包结果通过后续 `sandbox_control_result` 或 `sandbox_instance_status` 体现）

补充：清单拉取与孤儿清理

- 允许 `POST /api/admin/sandboxes/control` 支持 `action=report_inventory`
- 允许按 `instance_name` 清理（runId 可能为空）：

```json
{ "instanceName": "tuixiu-run-...", "action": "remove" }
```

此时 backend 需要从 `SandboxInstance` 查出 proxyId 并下发 `{ type: "sandbox_control", instance_name, action }`。

鉴权：

- 仅管理员/可信内网使用（按你现有 auth 策略接入）

## 6. 分布式“更深层”改造路线（必须写清，给未来迭代）

现在 backend 仍有大量对 workspace 的本地依赖（git diff/push/cleanup/worktree）。

示例耦合点：

- workspace 创建： [runWorkspace.ts](file:///d:/xyad/tuixiu/backend/src/utils/runWorkspace.ts)
- git diff： [runGitChanges.ts](file:///d:/xyad/tuixiu/backend/src/services/runGitChanges.ts)
- git push： [runReviewRequest.ts](file:///d:/xyad/tuixiu/backend/src/services/runReviewRequest.ts)

要真正做到 backend 远离 workspace，必须引入“执行面 API”（通过 WS/HTTP）把这些能力下沉到 acp-proxy：

- `workspace_control.create(run_id, repoUrl, baseBranch, auth)` -> 返回 workspaceRef
- `workspace_control.diff(run_id, base, head)` -> 返回文件列表/摘要
- `workspace_control.push(run_id, remote, branch)` -> 返回 push 结果

backend 只做：

- 保存凭证（或短期凭证下发）
- 记录审计
- 触发执行面动作

## 6.1 通信加密与节点身份（必须纳入 MVP）

### 6.1.1 加密通信（backend ↔ acp-proxy）

必须实现：

- `/ws/agent` 必须支持 `wss://`（TLS）
- backend 提供证书（可自签或 CA），acp-proxy 必须校验 server 证书

推荐实现（生产）：

- mTLS：backend 校验 client cert，确保只有授权的 acp-proxy 能注册
- 证书轮换：支持多证书并存与滚动更新

### 6.1.2 proxyId 固定与冲突处理

backend 当前用 `proxyId` 作为 agent/proxy 连接键（见 [gateway.ts](file:///d:/xyad/tuixiu/backend/src/websocket/gateway.ts) 中连接管理逻辑）。

要求：

- `proxyId` 必须固定（来自 acp-proxy 配置），backend 以此区分不同执行节点。
- backend 必须将 `SandboxInstance` 绑定到 `proxyId`（用于按节点列出容器与下发控制命令）。

冲突语义（必须明确且实现一致）：

- 若已有在线连接使用 `proxyId=X`，新的连接也声明 `proxyId=X`：
  - 默认策略：拒绝新连接，返回错误 `proxy_id_conflict` 并关闭 socket。
  - acp-proxy 需在本地报错并退出（或停止提供服务）。

可选策略（可配置）：

- takeover：允许新连接接管并踢掉旧连接，适用于滚动发布。

落地方式建议：

- 在 `register_agent` 收到后由 backend 返回 `register_ack { ok, proxyId, policy }` 或 `register_nack { ok:false, code, message }`。
- acp-proxy 未收到 ack 前不得接受控制类消息，避免未认证节点误入。

## 6.2 容器清理自治（双保险）

为了避免资源长期占用，即便 backend 或 proxy 任一侧出现故障，也应具备双向清理策略：

- backend：
  - 对 `SandboxInstance.lastSeenAt` 超过阈值的标记为 `missing` 并提示
  - 可选自动下发 `remove`（可配、需审计）
- proxy：
  - 对本机 workspaces/run-<run_id> 目录进行周期清理（按 expires_at 与安全阈值）
  - 对 inventory 中不再受管控的旧实例进行 best-effort 清理（仅限白名单前缀）

## 7. 开发拆分建议（给一个人干）

### 7.1 里程碑 A：Run 字段 + WS 协议升级

- Prisma migration：Run 增加 instanceName/ttl/status/lastSeen
- startIssueRun：创建 run 时写入 instanceName + ttl
- acp_open 下发扩展：instance_name + keepalive_ttl_seconds
- gateway：接收并落库 sandbox_instance_status + acp_exit

验收：

- 后端能看到 run 上的 instanceName/ttl/status 被更新
- proxy 断开/容器退出时，后端能看到状态变化

### 7.2 里程碑 B：后台管控接口

- 新增 admin 查询接口（按 proxyId/status 过滤）
- 新增 admin 控制接口（下发 sandbox_control）

验收：

- 后台能列出某 proxy 的 run 容器
- 能对 run 发 inspect/ensure/stop/remove，并看到状态回写
