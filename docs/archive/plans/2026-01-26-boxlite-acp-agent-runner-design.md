# BoxLite + ACP 多 Agent Runner 设计草案

**目标**：把“ACP 运行时”从某个具体 Agent（如 Codex）里抽离，支持 **可插拔的 ACP Agent**（Codex 只是其中一个 profile）；同时把“沙箱能力”抽象成可替换的 Provider（BoxLite 只是第一版），用于把 Agent 放到 **OCI/micro-VM 沙箱**中运行（隔离 + 可控资源 + 可观测）。

**背景（你当前仓库 `tuixiu/`）**：
- 现有架构是 `backend/`（Orchestrator）+ `acp-proxy/`（WS ↔ ACP stdio 桥）+ `frontend/`（UI）。
- `acp-proxy` 当前通过 `spawn()` 启动一个 ACP Agent 进程，并用 `@agentclientprotocol/sdk` 走 `initialize` / `session/new` / `session/load` / `prompt`。

**BoxLite（`boxlite-ai/boxlite`）关键点（与本方案相关）**：
- 目标场景：把不可信/高风险执行放入“Box（micro-VM）”里跑，支持 OCI 镜像、volume mount、资源限制、stdout/stderr streaming。
- Node SDK（`@boxlite-ai/boxlite`）提供 `box.exec()` 返回 `Execution`，可拿到 `stdin()/stdout()/stderr()`，因此**可以承载 ACP 的 ndjson/stdin/stdout 长连接**。
- Windows 原生不支持：需要 **WSL2（Linux + KVM）** 或直接 Linux 主机运行。

---

## 0. 已确认的落地形态（你选择的 A）

- **Windows**：`backend/`（Orchestrator）+ `frontend/`（UI）继续运行在 Windows（pwsh）。
- **WSL2（Linux）**：`acp-proxy/` 运行在 WSL2；它通过网络连接回 Windows 上的 Orchestrator。
- **沙箱（可替换）**：ACP Agent（例如 codex-acp）运行在“沙箱 Provider”里（第一版用 BoxLite；未来可替换）。

关键影响：
- `orchestrator_url` 不能再写 `localhost`（WSL2 里 `localhost` 指 WSL 自己）。需要配置为 Windows Host IP（例如 WSL2 的默认网关/`/etc/resolv.conf` 的 nameserver）。
- `cwd`/worktree 路径要做 **Windows 路径 → WSL 路径**转换（例如 `D:\\repo\\x` → `/mnt/d/repo/x`），才能在 WSL2/沙箱里访问。

WSL2 内获取 Windows Host IP（用于 `orchestrator_url`）示例：

```bash
# 方式 1：默认网关（通常就是 Windows Host）
ip route | awk '/default/ {print $3}'

# 方式 2：resolv.conf 的 nameserver（通常也是 Windows Host）
grep -m1 nameserver /etc/resolv.conf | awk '{print $2}'
```

BoxLite 前置条件（WSL2/Linux/macOS）：

```bash
# 需要 /dev/kvm 可用（WSL2 需开启对 KVM 的支持）
ls -al /dev/kvm
```

macOS（仅 Apple Silicon/arm64，macOS 12+）说明：

- BoxLite 在 macOS 上使用 Hypervisor.framework，不依赖 `/dev/kvm`。
- Intel Mac 暂不支持（请改用 `host_process` 或把 `acp-proxy` 放到 Linux/WSL2 运行）。

> 说明：在纯 Linux 主机上运行时，若 `backend/` 与 `acp-proxy/` 同机，可继续使用 `ws://localhost:3000/ws/agent`；`pathMapping` 仅在 “后端传入 Windows 路径但 proxy 在 Linux/WSL2” 时需要开启。

---

## 1. 推荐落点（近期开箱即用）

把“沙箱能力”集成在 `acp-proxy/` 内：`acp-proxy` 仍然负责 WS ↔ ACP，但“在哪运行 Agent（沙箱）”可插拔：

- `host_process`：直接在 proxy 所在的 OS 上 `spawn()`（用于开发/兜底；在 A 形态下就是在 WSL2 里跑，无 micro-VM 隔离）
- `boxlite_oci`：用 BoxLite 创建 Box（OCI 镜像），在 Box 里启动 ACP Agent 进程（A 形态下运行在 WSL2 内部）
- 未来：`docker` / `containerd` / `kata` / `firecracker` / `gvisor`…作为新的 sandbox provider（只要能提供“长连接 stdio/流式输出”的进程句柄）

这样：
- 后端基本不动（仍然只把 `run_id/prompt/cwd` 发给 proxy）。
- Codex 只是 `agent_command` 的一个默认值；换 Agent 只需换 `agent_command` 或启动另一个 proxy 实例。

---

## 2. ACP 运行时抽象（从 Codex/启动方式中解耦）

### 2.1 核心接口

在 `acp-proxy/` 内引入三个抽象（把“沙箱”和“ACP transport”分层）：

1) `SandboxProvider`（“我能在某个隔离环境里运行一个进程，并提供可持续读写的 stdio”）
- `runProcess(opts) => ProcessHandle`
  - `stdin: WritableStream<Uint8Array>`
  - `stdout: ReadableStream<Uint8Array>`
  - `stderr?: ReadableStream<Uint8Array>`（可选，仅用于日志）
  - `close(): Promise<void>`（终止进程/释放资源）
  - `onExit?(cb): void`（可选，用于检测 Agent 挂掉并重连）

2) `AcpTransport`（“我有一对 ACP ndjson 的输入输出流”）
- `input: WritableStream<Uint8Array>`
- `output: ReadableStream<Uint8Array>`
- `close(): Promise<void>`
- `onExit?(cb): void`（可选，用于检测 Agent 挂掉并重连）

3) `AgentLauncher`（“我负责把 ACP Agent 跑起来并返回 AcpTransport”）
- `launch(opts): Promise<AcpTransport>`

### 2.2 实现

- `HostProcessSandbox`（Provider）：封装现有 `spawn + Readable.toWeb/Writable.toWeb`（在 A 形态下运行于 WSL2）
- `BoxliteSandbox`（Provider）：用 `@boxlite-ai/boxlite` 创建 Box（OCI 镜像），在 Box 内 `exec()` 得到 `Execution`：
  - `stdin.write(bytes)` → `WritableStream` wrapper
  - `stdout.next()` / `stderr.next()` → `ReadableStream` wrapper（按字节输出）
- `DefaultAgentLauncher`：仅负责把 `agent_command` 交给选定的 `SandboxProvider` 来启动，然后把 `ProcessHandle.stdin/stdout` 直接映射为 `AcpTransport`。

> 关键：ACP 是 JSON-RPC NDJSON，必须“持续读写”；不能用 `SimpleBox.exec()`（那个会收集完输出后返回）。

---

## 3. 运行模型：Box 的生命周期如何映射 Run/Session？

建议先做 **1 Run = 1 Box = 1 ACP 进程**（隔离简单、心智负担低）：

- `Run.start`：proxy 创建 Box，并在 Box 内启动 Agent（ACP stdio）
- `Run.prompt`：复用该 Box 内的连接与 session
- `Run.completed/cancelled`：stop Box

优点：
- 彻底隔离：不同 Run 之间内存/进程隔离
- 崩溃影响面小：一个 Box 挂了不影响其它 Run

代价：
- 资源占用增加（但 BoxLite 设计目标就是高并发小 VM）

后续优化（可选）：
- `1 Agent = 1 Box`，在同一个 ACP 进程里跑多个 session（更省资源，但隔离弱一些）

---

## 4. 会话复用与持久化（“不要新建 session，要拉起历史 session”）

ACP 侧：
- 优先调用 `session/load(sessionId)` 复用历史 session；失败才 `session/new`。

BoxLite 侧要解决的事情：
- 如果 Agent 会把 session 落盘（多数实现会），需要把 **session 数据目录**挂载成 volume（host 持久化）。
- 建议目录：`.acp-sessions/<agentId>/`（host），挂进容器 `/sessions`，并通过 env 指定（取决于具体 Agent 实现）。

---

## 5. Workspace/Worktree 挂载策略

你当前系统为每个 Run 创建 worktree（例如 `.worktrees/run-<worktreeName>`），BoxLite 模式下建议：
- 将该 worktree mount 到容器 `/workspace`（rw）
- `session/new` 的 `cwd` 传 `/workspace`

Windows + WSL2 注意点（高风险坑）：
- 如果后端在 Windows、proxy 在 WSL2，`D:\\...` 需要转换为 `/mnt/d/...` 才能 mount。
- 性能：`/mnt/d` IO 相对慢；长期建议把 repo/worktrees 放到 WSL2 文件系统内（如 `~/work/tuixiu`）。

---

## 6.（你要的 C 模式）沙箱初始化：工具链 + 配置 + skills 怎么“搭配起来”

你提到的需求本质上是“把 agent 的运行时做成可复用的、可版本化的 environment”，建议拆成三层：

### 6.1 Agent Runtime Image（OCI 镜像，强烈推荐）

把**不会频繁变动**但必须存在的东西，尽量在镜像构建阶段安装：

- **基础工具**：`git`、`ca-certificates`、`bash`、`curl`、`jq`、`ripgrep`（可选）
- **Node 工具链**：Node 20+（因为 `codex`/`codex-acp` 依赖）、`npm/pnpm`（可选）
- **Codex**：安装 `codex` CLI（例如 npm 全局包）
- **ACP 适配器**：安装 `@zed-industries/codex-acp`（或你选的其它 ACP agent wrapper）
- **GitHub CLI**：安装 `gh`（用于 agent 内部操作 GitHub；即使当前后端已有 GitHub API，也建议预置，未来更灵活）

这样做的收益：
- 运行时无需“现场安装”，减少网络依赖、减少不确定性
- 版本可控：镜像 tag = agent 环境版本

### 6.2 Agent Home Volume（持久化、可写）

把**需要跨 run/session 复用**的内容放到 host（WSL2）目录，并挂载给沙箱：

- `~/.tuixiu-sandbox/<agentId>/codex-home` → 容器内 `$HOME`（或 `$HOME/.codex`）
  - `~/.codex/`：skills、superpowers、缓存、session 数据（按需分目录）
  - `~/.config/gh/`：gh 登录态（也可以不用持久化，改用 `GH_TOKEN`）

建议拆目录（更干净）：
- `state/`：ACP session 持久化（`/sessions`）
- `codex/`：`$HOME/.codex`（skills + 配置）
- `cache/`：npm/pnpm 缓存（可选，提速）

### 6.3 Bootstrap Script（容器 entrypoint，解决“skills/配置初始化”）

即使镜像里装好了二进制，**skills / 配置 / 凭证**仍然需要在运行时注入或初始化。

推荐做法：镜像内提供一个 `entrypoint.sh`：
- 读取环境变量（见下）
- 若 `$HOME/.codex/skills` 为空：从 `/opt/skill-pack` 复制默认技能包进去（镜像内自带）
- 若设置了 `SKILL_REPO_URL`：可选地 `git clone/pull` 到 `$HOME/.codex/skills`（需要网络；适合开发环境）
- 若设置了 `GH_TOKEN`：执行 `gh auth setup-git`（或最小化写入 config）
- 配置 git（`user.name/email`、`safe.directory`、可选 `credential.helper`）
- 最后 `exec codex-acp`（或你配置的 ACP agent 命令）

### 6.4 Secrets 注入（不要 bake 到镜像）

必须运行时注入：
- `OPENAI_API_KEY` / `CODEX_API_KEY`（Codex 必需）
- `GH_TOKEN`（需要 gh 或 git push 走 https token 时）
- （可选）`GITLAB_TOKEN` 等

注入渠道（按安全优先级）：
1) proxy 在 WSL2 读取 host env → 透传给沙箱 env（最简单）
2) proxy 读取后端 Project secrets（DB）→ 透传（需要你接受“后端把 token 发给 proxy”的安全边界）
3) secrets 文件挂载（`/run/secrets/...`）→ entrypoint 读取（更接近生产）

### 6.5 资源与网络（C 模式）

资源：由 `SandboxProvider` 统一表达（cpu/mem/磁盘），BoxLite 映射到 `BoxOptions.cpus/memory_mib/disk_size_gb`。

网络：BoxLite 默认有出网（通过 gvproxy NAT）。要做“网络开关”，建议两条线：
- **短期（可落地）**：entrypoint 内通过 `iptables/nft` 在 guest 内禁用出网（`SANDBOX_NETWORK=off`）。
- **长期（更干净）**：若 BoxLite 上游暴露“禁用网络 backend”的选项，则由 provider 原生实现。

> 注意：Codex 本身需要访问模型 API，因此对 Codex 类 agent，`network=off` 只适用于“回放/离线检查”等特殊模式。

---

## 6. 多 ACP Agent：Codex 只是一个 profile

最简单、也最符合你当前系统模型的做法：
- **一个 proxy 实例 = 一个 Agent**（配置不同 `agent.id` / `agent_command` / runner）。
- 后端/前端提供“选择 Agent”的能力（Project 默认 Agent、Run 启动时可覆盖）。

可选增强（以后再做）：
- 一个 proxy 支持多个 agent profiles（需要在 WS 协议里把 run 映射到 profile，复杂度更高）。

---

## 7. 下一步需要你确认的 1 个细节（写代码前）

为了后续能替换 BoxLite，你希望“沙箱 Provider”第一版必须支持的最小能力集合是哪一个？

A) 只要能跑进程 + 流式 stdio（不做 volume mount/资源限制）  
B) 需要 volume mount（worktree/session 目录持久化）  
C) 需要 volume mount + CPU/Mem 限制 + 网络开关（更接近生产沙箱）  
