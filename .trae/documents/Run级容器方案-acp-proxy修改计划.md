# Run 级容器方案：acp-proxy 修改计划（执行面）

目标：给负责 acp-proxy 的开发同学一份可直接开工的实施说明。

## 0. 背景与结论

在“backend 不与 workspace 同机”的部署形态下，ACP 的执行面必须靠近代码与容器。

- ACP 是双向 JSON-RPC：Agent 会反向调用 Client 的 `fs/*`、`terminal/*`、`session/request_permission` 等方法；这些方法必须在**可访问 workspace 的位置**实现。
- 因此：acp-proxy 从“隧道/启动器”演进为 **Agent Host（执行面）**。

本方案的核心收敛点：

- 每个 Run 对应一个容器（强隔离）
- `sandbox_instance_id = run_id`
- `instance_name` 由 backend 下发（固定、可预测）
- 运行结束默认保活 30 分钟（后端可覆盖）
- acp-proxy 负责容器生命周期、workspace、ACP Client 方法处理（fs/terminal/permission）以及把结构化事件/产物回传 backend

## 1. 当前代码现状（需要理解的事实）

当前 acp-proxy 的入口在 [index.ts](file:///d:/xyad/tuixiu/acp-proxy/src/index.ts)。它的行为更偏向：

- WebSocket 连接 orchestrator
- 收到 `acp_open` 后，启动一个 ACP agent 进程（经 sandbox）
- 将 WS 收到的 JSON-RPC 透传给 agent，agent 输出再透传回 WS

注意：当前仓库里，backend 的 [acpTunnel.ts](file:///d:/xyad/tuixiu/backend/src/services/acpTunnel.ts) 才是 ACP Client（实现 fs/terminal），这在“backend 远离 workspace”时不可行。

本修改计划要求把 ACP Client 的能力迁移到 acp-proxy（执行面）。

## 2. 目标能力清单（必须实现）

### 2.1 Run 级容器与可恢复

- 每个 `run_id` 创建/复用一个容器（OCI container 或 boxlite VM）。
- 容器名固定（`instance_name`）以实现：
  - proxy 重启后可通过 inspect 重新接管
  - 容器丢失可被判定为 missing
  - backend 能对同一个 run 发起 restart/stop/remove
- `acp_close` 不立即销毁容器，而是进入保活期：默认 1800s（30min），可被 backend 在 `acp_open` 里覆盖。

### 2.2 执行面 = workspace 拥有者

- workspace 创建与复用迁移到 acp-proxy：
  - 最小目标：Run workspacePath 在容器内统一为 `/workspace`，并将宿主机某个 run 工作目录 bind mount 进去。
  - workspace 的 git clone/worktree 方案先不要在 backend 执行（backend 将逐步只持有 repoUrl/branch/token 之类参数）。

### 2.3 ACP Client（协议闭环）

acp-proxy 需要实现 ACP Client 侧的方法（至少）：

- `session/request_permission`：输出默认“allow_once”（可扩展为需要后端审批）
- `fs/read_text_file`、`fs/write_text_file`
- `terminal/*`：create/output/wait_for_exit/kill/release

重要：这些方法的执行必须发生在**对应 run 容器的 workspace**里，不能落到 proxy 宿主机任意目录。

### 2.4 后台可观测（事件与状态上报）

acp-proxy 必须向 backend 回传两类信息：

1) 容器/沙箱实例状态（给后台展示与自治）
2) run 执行的结构化事件（日志/步骤/产物）

### 2.5 容器清单同步（让服务端拿到“当前/历史容器列表”）

仅靠 run 的状态上报不足以覆盖“孤儿容器”场景：

- proxy 重启/升级导致内存态丢失，但容器仍在
- 容器是历史遗留（例如旧版本命名规则）
- backend 记录不全或被清理

因此 acp-proxy 必须支持“清单同步”：把当前机器上符合规则的容器/实例列表上报给 backend，并支持 backend 主动触发拉取清单。

## 3. 运行时模型（必须按这个心智写代码）

### 3.1 核心对象

- `RunRuntime`（每个 run_id 一个）
  - `run_id`
  - `instance_name`
  - `keepalive_ttl_seconds`
  - `expires_at`（close 后到期时间）
  - `sandboxHandle`（容器/VM 的控制句柄）
  - `acpTransport`（agent 进程 stdio transport）
  - `acpConnection`（ACP 协议连接；client+server 两端）

- `SandboxInstance`（对外可控的实例）
  - `provider`: container_oci | boxlite_oci
  - `status`: creating | running | stopped | missing | error
  - `last_seen_at` / `last_error`

### 3.2 状态机（核心）

```
acp_open
  -> ensure_instance_running(instance_name)
  -> ensure_workspace_attached(/workspace)
  -> ensure_acp_agent_connected(run_id)
  -> reply acp_opened(ok=true)

acp_close
  -> mark expires_at = now + ttl
  -> keep instance running until expires_at

idle_timer
  -> if now > expires_at -> stop/remove instance (policy)

agent_exit / instance_missing
  -> notify backend (sandbox_instance_status + acp_exit)
```

## 4. WebSocket 协议（必须实现的消息）

### 4.1 backend → acp-proxy

#### `register_agent`（已有）

保持现状。

#### `acp_open`（需要扩展）

```json
{
  "type": "acp_open",
  "run_id": "<uuid>",
  "cwd": "<opaque-workspace-ref-or-path>",
  "init": { "script": "...", "timeout_seconds": 300, "env": {"K":"V"} },
  "instance_name": "tuixiu-run-<run_id>",
  "keepalive_ttl_seconds": 1800
}
```

说明：

- `run_id` 是逻辑 ID，也是 sandbox_instance_id。
- `instance_name` 由 backend 生成并下发，proxy 不能自行变化。
- `keepalive_ttl_seconds` 可选，默认 1800。

#### `acp_message`/`acp_close`（已有）

语义保持，但执行对象必须绑定到对应 `run_id` 的 ACP 连接。

#### `sandbox_control`（新增）

```json
{ "type": "sandbox_control", "run_id": "<uuid>", "instance_name": "...", "action": "inspect" }
```

action: `inspect | ensure_running | stop | remove | report_inventory`。

### 4.2 acp-proxy → backend

#### `agent_update`（复用；新增 content.type）

新增 `sandbox_instance_status`：

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
    "last_seen_at": "2026-01-28T12:00:00.000Z",
    "last_error": null
  }
}
```

#### `acp_exit`（新增或补齐）

用于让 backend 知道 run 的 agent 进程退出：

```json
{ "type": "acp_exit", "run_id": "<uuid>", "instance_name": "...", "code": 0, "signal": null }
```

#### `sandbox_control_result`（新增）

```json
{
  "type": "sandbox_control_result",
  "run_id": "<uuid>",
  "instance_name": "...",
  "action": "inspect",
  "ok": true,
  "status": "running",
  "details": { }
}
```

#### `sandbox_inventory`（新增）

用于让 backend 获得“这个 proxy 当前/历史的容器列表”，支持后台清理。

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

说明：

- `run_id` 在清单中可选：若能从命名规则解析则带上；否则为 null（backend 仍可按 instance_name 管控）。
- 清单上报触发方式：
  - proxy 启动后第一次 WS 连接成功立即上报一次
  - backend 也可通过 `sandbox_control` 触发（见下文）

## 5. Sandbox/容器层实现要求

目标：支持“固定 name 的实例生命周期管理”。

### 5.1 ContainerSandbox（container_oci）

需要新增能力（最小集）：

- `inspect(name)`：存在/运行状态/创建时间等
- `ensureRunning(name, config)`：不存在则创建，存在但 stopped 则 start，running 则复用
- `stop(name)`、`remove(name)`

容器创建必须：

- `--name <instance_name>`
- mount run workspace 到 `/workspace`
- 工作目录 `-w /workspace`
- 环境变量注入（例如 OPENAI_API_KEY）

### 5.2 BoxLiteSandbox（boxlite_oci）

同样需要支持“固定 name 的实例生命周期”，但实现方式可能是 boxlite 的 instance id/tag。

如果 BoxLite 无法可靠复用，需要在 proxy 层将 `inspect/ensure` 做为 best-effort 并上报 missing。

## 6. Workspace 设计（分布式必须项）

本阶段建议采用最简单的稳定语义：

- 容器内固定：`/workspace`
- 宿主机固定根：`<acp-proxy-host>/workspaces/run-<run_id>`
- 每次 run 执行都只允许访问 `/workspace` 下的路径

后续要做“更强分布式”（多 host、迁移）时，再把 workspace 挂载改成：

- 对象存储拉取 + 缓存
- 或者 NFS/CSI 卷

## 7. ACP Client 侧能力实现（建议落地方式）

推荐实现结构：

- `AcpClientFacade`：把 `fs/*`、`terminal/*`、`request_permission` 的实现绑定到 `RunRuntime`（也就是绑定 instance/workspace）。
- `terminal/*` 不要直接在宿主机 spawn；必须在容器内执行。
  - container_oci：用 `docker exec`/`podman exec` 作为 v1 实现即可
  - boxlite_oci：用 boxlite 提供的 exec/runProcess

输出截断：terminalOutput 需要 byte limit（例如 2MB 默认），避免 WS payload 过大。

## 8. 安全要求（必须做到）

- 任何来自 agent 的文件路径都必须做 workspace root 校验（禁止逃逸）。
- secret（OPENAI_API_KEY、token）不得写入日志，不得回传到 event payload。
- `instance_name` 只能使用 backend 下发值（但执行前需校验字符集/长度，非法则拒绝并上报错误）。

### 8.1 加密通信（acp-proxy ↔ backend）

必须开启传输加密，避免明文 WS 被窃听/劫持（尤其是后续会承载 sandbox_control/remove 等高危操作）。

最低要求：

- `wss://`（TLS）替代 `ws://`
- backend 配置证书（可自签或 CA）
- acp-proxy 校验证书（禁止忽略校验）

推荐要求（生产）：

- mTLS（双向证书）：backend 校验 client cert，acp-proxy 校验 server cert
- 证书吊销与轮换策略（至少支持热更新/滚动重启）

补充认证（建议与 mTLS 同时启用）：

- acp-proxy 在 `register_agent` 时携带 `auth`（例如签名 token 或 HMAC）

### 8.2 proxyId（acp-proxy 身份）与冲突处理

acp-proxy 必须具备稳定身份 `proxyId`，用于：

- backend 将 sandboxes/run 绑定到具体的执行面节点
- inventory/状态上报按 proxyId 做分区
- 后台精确下发控制命令到指定 proxy

要求：

- `proxyId` 必须固定（来自配置文件或持久化文件），不能每次启动随机生成。
- 推荐命名：uuid 或有意义的节点名（例如 `proxy-prod-01`），但必须满足唯一性。

冲突语义（必须明确）：

- backend 以 `proxyId` 为唯一键维护在线连接。
- 若出现第二个连接使用相同 `proxyId`：
  - backend 必须拒绝新连接（推荐）并返回明确错误码/消息（例如 `proxy_id_conflict`），随后关闭 socket。
  - acp-proxy 收到该错误后应立即退出进程（或进入退避重试，但不得继续提供服务），并打印可定位的错误信息。

可选策略（不推荐，但可配置）：

- backend 接受新连接并踢掉旧连接（"takeover"），用于滚动发布；此时 backend 需要通知旧连接 "proxy_id_taken_over"。

### 8.3 控制面高危指令保护

- `sandbox_control.remove/stop` 必须要求 backend 已认证且具备管理员权限（backend 负责鉴权，proxy 仍需校验消息来源与签名）。
- proxy 必须对 `instance_name` 做白名单校验（例如仅允许 `tuixiu-run-` 前缀），禁止清理任意容器。

## 9. 开发拆分建议（给一个人干）

### 9.1 里程碑 A：容器可控与保活

- 实现 `instance_name` 的 ensure/inspect/stop/remove
- 支持 `keepalive_ttl_seconds` 与回收定时器
- 完成 `sandbox_instance_status` 上报

验收：

- 同一个 run 多次 `acp_open` 复用同一个容器
- `acp_close` 后 30 分钟内容器仍存在
- 30 分钟后容器被 stop/remove（按策略）且 backend 收到状态变化

### 9.2 里程碑 B：ACP Client 下沉

- 实现 ACP Client：fs/terminal/request_permission，全部在容器内执行

验收：

- agent 能读取/写入 workspace 文件
- agent 能执行命令且 output 可被读取（有截断）

## 10. 需要 backend 配合的接口（对接点）

- `acp_open` 必须下发 `instance_name` 与可选 TTL
- backend 必须能接收并落库 `sandbox_instance_status` 与 `acp_exit`
- backend 需要实现 `sandbox_control` 下发（inspect/ensure/stop/remove）
