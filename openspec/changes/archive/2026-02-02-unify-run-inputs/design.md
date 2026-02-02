## Context

当前 run 启动链路把输入准备拆分在多处逻辑里：workspacePolicy 决定 workspace 初始化；skillsManifest 走单独的下载/解压/落盘；并依赖若干固定路径约定（例如把运行时 home 绑在 workspace 下）。随着需求扩展（MCP、自定义 agent.md、更多“输入包”类型）以及新增 provider（如 `bwrap`/bubblewrap），现有结构会导致：

- 新增输入类型需要在多个模块里追加分支判断，难以复用同一套安全约束（目标路径、解压、只读/可写分区）
- 路径语义不清：`/root`、`/workspace` 等概念被当作 home 使用，无法稳定表达“沙盒内 ~ 对应的 home”
- provider 差异（container/boxlite/host_process/bwrap）下，路径与权限处理分散且容易出现不一致

本变更的核心是把“运行前输入投递”收敛成一个统一抽象，并把 home 概念明确为 `USER_HOME`（沙盒内 `~`）。

## Goals / Non-Goals

**Goals:**

- 引入统一的输入清单模型（`agent-inputs`）：用一致的字段描述输入来源、目标逻辑根、落地方式与权限意图。
- 定义逻辑根目录并在 proxy 侧解析为真实 guest 路径：
  - `WORKSPACE`：代码/产出区
  - `USER_HOME`：沙盒内 `~` 对应 home
  - （可选）`SCRATCH`：临时目录
- 将 skills、MCP、agent.md 等“输入包”统一视为输入资源的一种，落地到 `USER_HOME` 下受控子树（例如 `USER_HOME/.tuixiu/...`）。
- 统一输入落地的安全约束（即便第一期不做 hash 完整性）：
  - 目标路径规范化与根目录白名单（禁止路径逃逸）
  - 压缩包安全解压（拒绝 ZipSlip/symlink，限制文件数/大小）
  - 权限意图一致（默认允许写入 `USER_HOME`）
- 以“重写”方式统一输入投递：以 `agentInputs` 作为唯一输入清单契约。

**Non-Goals:**

- 第一阶段不引入强完整性校验/签名体系（如 sha256 校验、签名验证）。
- 不在本设计中展开输出收集/产物归档/外发策略（可在后续变更单独设计）。
- 不改变现有 workspacePolicy 的业务语义，只重构其“落地方式”以接入统一输入管线。

## Decisions

1) 采用 `USER_HOME` 作为“沙盒内 ~”的权威概念，而不是把 home 绑定到 workspace

- 理由：home 是用户/进程级语义，应该由 provider/运行用户决定；而 workspace 是项目/任务级语义。两者解耦后，才能自然承载 MCP、agent 指令、工具缓存等“非 workspace 输入”。
- 结果：运行时输入包、MCP、agent 指令、缓存等“非 workspace 输入”统一落在 `USER_HOME` 下。

2) 输入以“逻辑根 + 相对路径”的 target 表达，禁止直接传绝对路径

- 目标结构示例：
  - `WORKSPACE/<...>`：repo checkout、产出
  - `USER_HOME/<...>`：运行时输入包与配置文件（第一期不强制分层/固定子目录；可按需自行组织）
- 理由：消除 `/root`/`/workspace` 等环境差异，避免路径逃逸；让同一输入清单在不同 provider 下稳定工作。

3) 输入来源与落地方式解耦：source/apply 组合可扩展，provider 负责能力适配

- 第一批支持的 source/apply（面向现有需求）：
  - repo：`source=git` + `apply=checkout`（对应 workspacePolicy=git）
  - skills/mcp/agent 包：`source=http_zip` + `apply=extract`
  - 小文本指令：`source=inline_text` + `apply=writeFile`
- 约束：第一期本地测试 **需要** provider 支持“挂载（mount）”，具体形式为 **bind mount**（例如把宿主 workspace 绑定到沙盒内 `/workspace`）。同时第一期也 **需要** 完成 download/extract/copy（用于将 skills/MCP/agent 指令包等运行时输入落地到 `USER_HOME`）。在不具备 mount（bind mount）能力的环境下，download/extract/copy 可作为 workspace 的替代落地路径（后续再完善）。

3.1) bwrap provider 的“用户态视图”构建

- 目标：在 bwrap 下提供完整、可组合的“用户态视图”，使 agent 的 `~`/用户名/UID/GID/工作目录表现稳定且可控。
- 约定（实现层指引）：
  - 身份：通过 bwrap 的 user namespace 映射设置 UID/GID（例如 `--unshare-user` + `--uid/--gid` 或等价方式）
  - 名称：通过绑定一份受控的 `/etc/passwd`（及可选 `/etc/group`）提供 `getpwuid()` 可解析的用户名
  - Home：绑定 home 目录并设置 `HOME`/`USER`/`LOGNAME`，使 `USER_HOME` 与 `~` 一致
  - Workspace：将目标工作目录绑定到 `/workspace` 并 `--chdir /workspace`
- 说明：bwrap 不负责“创建用户”，但通过 UID/GID + passwd/group + env 组合即可满足 Node/Python 等运行时对用户信息解析的预期。

3.2) env 合并策略（第一期）

- 原则：环境变量属于启动控制面，主要由 `init.env` 与 provider user view 决定；`agentInputs` 仅允许非常有限的 env 补丁（用于输入可发现性）。
- 合并顺序（建议约束实现一致性）：
  1. 基底：`init.env`
  2. provider user view：设置/覆盖 `HOME`、`USER`、`LOGNAME`
  3. 可选：`agentInputs.envPatch`（仅允许 `HOME`、`USER`、`LOGNAME`）
  4. 最终：应用 env allowlist 后启动 agent

4) `USER_HOME` 权限策略：简化为统一可写

- `USER_HOME` 在 run 生命周期内 SHALL 允许 agent 读写（用于日志、运行状态、缓存与输入包的运行时变更）。
- 理由：在“沙盒”边界内优先降低心智负担与实现复杂度；输入稳定性与可复现性不作为第一期目标。

5) 重写：以 `agentInputs` 作为唯一契约

- 后端 MUST 直接下发 `agentInputs`，覆盖 workspace 与运行时输入包（skills/MCP/agent 指令包等）。
- acp-proxy MUST 以 `agentInputs` 作为唯一输入来源执行落地，不提供 `skillsManifest` 兼容/映射层。
- 现有依赖旧字段/旧路径约定的行为视为 BREAKING（在实现与 runbook 中明确调整点与检查方法）。

## Risks / Trade-offs

- [路径语义变更导致兼容问题] → 通过明确 `USER_HOME` 的契约与 runbook 说明新旧路径对应关系；提供回滚开关。
- [可写 home 增加污染风险] → 强制 target 白名单与解压安全；在需要时再引入完整性/只读视图作为后续迭代。
- [provider 差异导致实现复杂] → 把“能力差异”集中在 layout 解析与少量文件系统适配层；业务输入清单保持 provider-agnostic。
- [第一期不做完整性校验可能被投毒] → 先收紧来源渠道（仅受控下载端点）、限制大小/文件数、增强审计日志；后续迭代引入 hash/签名而不改变输入抽象。
