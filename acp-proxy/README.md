# acp-proxy

`acp-proxy` 是一个 Node 服务，作为 **ACP 执行面（Agent Host）**：管理 Run 级沙箱实例，在沙箱内启动 ACP agent，并在本机实现 ACP Client 方法（`fs/*`、`terminal/*`、`session/request_permission`），再将 ACP 消息与结构化状态/清单回传后端 Orchestrator。

默认使用 “沙箱启动 Agent”。`host_process` 仅作为低风险 PoC（几乎无隔离），请勿在生产使用。

- Linux（含 WSL2）+ `/dev/kvm`：使用 BoxLite 启动容器/VM 并运行 ACP Agent
- macOS Apple Silicon（arm64）：使用 BoxLite
- Windows 原生 + macOS Intel（x64）：使用容器运行时（`docker`/`podman`/`nerdctl`）启动 ACP Agent 容器（默认 `docker`，可配置）
- `host_process`：直接在宿主机运行 ACP Agent（仅 PoC，低隔离）

## 架构与流程

1. 在一台机器上启动 `acp-proxy`
2. `acp-proxy` 作为 WebSocket client 连接后端 `orchestrator_url`
3. 连接成功后发送 `register_agent` 上报 `agent.id/name/max_concurrent/capabilities`
4. 后端通过该 WebSocket 下发 Run 指令：`acp_open` / `prompt_send` / `acp_close` / `sandbox_control`（以及会话控制：`session_cancel` / `session_set_mode` / `session_set_model`）
5. `acp-proxy` 收到 `acp_open`/`prompt_send` 后：创建/复用该 run 的沙箱实例（`instance_name`，默认 `tuixiu-run-<run_id>`），容器内 workspace 固定为 `/workspace`，可选执行 `init.script`（例如 `git clone`），再启动 ACP agent（`agent_command`），并由 `acp-proxy` 自行 `initialize`
   - `sandbox.agentMode=exec`：通过 `docker exec` 在已运行容器内启动 agent（历史默认）
   - `sandbox.agentMode=entrypoint`：容器主进程为 agent（PID1），acp-proxy 通过 stdio 与其通讯；如提供 `init.script`，会在 agent 启动前执行
6. ACP agent 的输出通过 `acp-proxy` 回传后端；同时 agent 反向调用的 `fs/*`/`terminal/*`/`session/request_permission` 由 `acp-proxy` 本机实现

## 运行前提

- 需要能够访问后端 WebSocket：`orchestrator_url`（建议使用 `wss://`）
- sandbox 运行环境：
  - BoxLite：Linux/WSL2 需要 `/dev/kvm`；macOS 仅支持 Apple Silicon（arm64）
  - Container：Windows/macOS Intel 需要可用的容器运行时（默认 `docker`，也可用 `podman/nerdctl`）
- 建议显式配置 `sandbox.provider`（默认 `container_oci`）
- `sandbox.runtime`（仅 `provider=container_oci`）会自动探测 `docker/podman/nerdctl`（若均不可用会报错）
- `sandbox.image`（非 `host_process`）默认 `tuixiu-codex-acp:local`
- 需要把 `OPENAI_API_KEY` 等密钥通过 `sandbox.env` 注入到 guest（不要提交到仓库）

## 配置

配置文件可以是 TOML 或 JSON（推荐 TOML，支持注释）。可以直接参考示例：

- `config.toml.example`：统一示例（通过 `sandbox.provider` 选择 `boxlite_oci` / `container_oci`）

关键字段：

- `orchestrator_url`：后端 WebSocket 地址，例如 `wss://backend.example.com/ws/agent`
- `agent.id`：这台机器上报到后端的 agent 标识（会自动生成并落盘；一般无需手填）
- `sandbox.terminalEnabled`：是否允许执行终端类指令（建议只在沙盒可信时开启）
  - ACP 约定：Agent 需在 initialize 的 clientCapabilities.terminal 为 true 时才可调用 terminal/*
- `sandbox.agentMode`：ACP agent 启动模式（`exec`/`entrypoint`）
- `sandbox.provider`：`boxlite_oci` / `container_oci` / `host_process`（PoC；必须 `terminalEnabled=false` 且 `workspaceProvider=host`）
- `sandbox.image`：用于运行 ACP 的镜像（`host_process` 不需要；默认 `tuixiu-codex-acp:local`）
- `agent_command`：在 guest 内执行的 ACP 启动命令
- `sandbox.runtime`（仅 `provider=container_oci`）：容器运行时（可选；默认自动探测）
- `sandbox.workingDir`：ACP 工作目录（默认 `/workspace`）
- `sandbox.workspaceProvider`：workspace 提供方（`host`/`guest`）。`host` 模式使用宿主机创建并挂载 workspace；`guest` 由容器内 init 负责创建。
- `inventory_interval_seconds`：周期性上报 inventory 的间隔秒数（默认 300；设为 0 可关闭）

### profiles

`profiles` 允许在一份配置里为不同部署环境覆盖部分字段，例如切换 `orchestrator_url`、`sandbox.terminalEnabled`、`sandbox.provider` 或 `sandbox.image`。

启动时通过 `--profile <name>` 选择：

- `node dist/index.js --config config.toml --profile sandboxed`

### 环境变量覆盖（容器友好）

运行时可以用环境变量覆盖配置（优先级高于 config 文件与 profile 合并结果）：

- `ACP_PROXY_ORCHESTRATOR_URL`
- `ACP_PROXY_AUTH_TOKEN`
- `ACP_PROXY_TERMINAL_ENABLED`（`1`/`true` 为开启）
- `ACP_PROXY_INVENTORY_INTERVAL_SECONDS`（0 关闭周期性上报）
- `ACP_PROXY_SANDBOX_PROVIDER`（`boxlite_oci`/`container_oci`/`host_process`）
- `ACP_PROXY_SANDBOX_IMAGE`
- `ACP_PROXY_SANDBOX_WORKING_DIR`
- `ACP_PROXY_SANDBOX_WORKSPACE_PROVIDER`
- `ACP_PROXY_SANDBOX_RUNTIME`
- `ACP_PROXY_CONTAINER_RUNTIME`（兼容旧字段）

## Runbook：清理 orphan 与 workspace

推荐优先使用前端管理后台（Admin → ACP Sessions）进行操作：

- `Prune Orphans`：清理“managed 且不在后端 expected 列表中”的遗留实例（容器/box/host 进程）
- `Remove Workspace`：按 runId 删除该 Run 的 workspace（`workspaceProvider=host` 会删 `workspaceHostRoot/run-<runId>`；`guest` 会删 guest 内 `/workspace/run-<runId>`）
- 操作后 proxy 会通过 `sandbox_inventory.deleted_instances/deleted_workspaces` 上报删除结果，后端会将其标记为 deleted 并可在筛选中查看

## 开发

在仓库根目录安装依赖后：

- `pnpm -C acp-proxy test`
- `pnpm -C acp-proxy typecheck`

## Boxlite 通讯自检（e2e）

`BoxliteSandbox` 与 ACP agent 的通讯通道是 `stdin/stdout`。仓库提供了一个可选 e2e 用例来验证这条链路（默认跳过，不影响日常单测）。

在 Linux/WSL2 或 macOS(arm64) 上运行：

- `ACP_PROXY_BOXLITE_E2E=1 pnpm -C acp-proxy test`

## acp-proxy 真机自检（e2e）

仓库提供了一个可选 e2e 用例用于验证 “真实的 acp-proxy 进程” 能否：

- 连接 Orchestrator WebSocket
- 成功发送 `register_agent`
- 接收 `acp_open` 并通过 Boxlite 拉起一个 guest 内进程（用 `sh + cat/sleep` 做最小模拟）

在 Linux/WSL2 或 macOS(arm64) 上运行：

- `ACP_PROXY_E2E=1 pnpm -C acp-proxy test`

## 是否需要先构建镜像并安装 codex-acp

不强制，但强烈建议：

- 推荐默认：构建你自己的 `sandbox.image`，把 Node 与 `codex-acp`（以及 git/ssh 等工具）预装在镜像里，并使用 `agent_command=["codex-acp"]`
- 临时验证：也可以让 guest 里用 `npx --yes @zed-industries/codex-acp` 现装现跑（需要 guest 能访问公网）

## Codex 配置文件挂载（推荐）

`codex` / `codex-acp` 通常需要读取宿主机的 `~/.codex/config.toml`。建议通过 `sandbox.volumes` 以只读方式挂载到 guest：

```toml
[[sandbox.volumes]]
hostPath = "C:/Users/<you>/.codex/config.toml" # Windows 示例
guestPath = "/root/.codex/config.toml"
readOnly = true
```
