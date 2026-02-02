# agent-inputs

## Purpose

定义 ACP run 启动时“输入投递”的统一契约：系统如何描述并落地 workspace、运行时输入包（skills/MCP/agent 指令包等）、以及与沙盒内 `~` 对应的 `USER_HOME` 路径语义。

## Requirements

## ADDED Requirements

### Requirement: Run inputs are expressed as a unified manifest
当 run 启动需要投递运行时输入时，系统 SHALL 使用统一的输入清单（manifest）描述所有输入项，而不是在不同模块/策略中分散表达。

#### Scenario: Backend provides a single list of inputs
- **WHEN** 某 run 同时需要 repo workspace 与一个运行时输入包（例如 MCP/agent 指令包）
- **THEN** backend 下发给 acp-proxy 的初始化信息中包含一个统一的输入清单，清单中包含这两类输入项

### Requirement: The manifest has an explicit version and an ordered item list
统一输入清单 MUST 具备显式版本号与输入项列表，满足：

- manifest MUST 包含 `version`（整数）
- manifest MUST 包含 `items[]`（数组）
- `items[]` 的顺序 MUST 代表执行顺序

#### Scenario: Proxy rejects unknown manifest version
- **WHEN** acp-proxy 收到的 manifest `version` 不受支持
- **THEN** run 启动失败且 agent 不被启动

### Requirement: Each input specifies source, target root, apply method, and access intent
每个输入项 MUST 明确包含：

- `id`：输入项标识（用于日志/排障/幂等）
- `source`：输入来源（第一期至少包含 hostPath 与受控下载端点 zip）
- `target`：目标位置，使用 “逻辑根目录 + 相对路径” 表达
- `apply`：落地方式（第一期至少包含 bind mount、copy、download+extract）
- `access`：权限意图（`ro`/`rw`），若缺省则默认等同 `rw`

#### Scenario: Proxy can apply an input without policy-specific branching
- **WHEN** acp-proxy 收到一个输入项（包含 source/target/apply/access）
- **THEN** acp-proxy 可在不依赖 workspacePolicy 等分散策略特判的前提下，对该输入项执行对应落地动作

### Requirement: Env is controlled by init, not by agentInputs (except an allowlisted envPatch)
系统 MUST 将环境变量视为启动控制面配置：env 的主要来源为 `init.env`（及 provider 的 user view），而不是 `agentInputs`。

- `agentInputs` MUST NOT 携带任意的 `env` 键值对（避免把输入投递清单膨胀为启动总配置）
- 系统 MAY 支持一个可选的 `agentInputs.envPatch`，但 MUST 仅允许对少量与输入可发现性相关的键进行补丁（例如 `HOME`、`USER`、`LOGNAME`）
- 若 `agentInputs.envPatch` 存在，acp-proxy MUST 在启动 agent 前将其与 `init.env` 合并，并最终应用 env allowlist

#### Scenario: envPatch cannot override unrelated env
- **WHEN** `agentInputs.envPatch` 尝试设置未被允许的 env key（例如 `TUIXIU_*` 或 token 类变量）
- **THEN** acp-proxy 拒绝该 patch 并阻止 agent 启动

### Requirement: Items are applied sequentially and failures abort the run
acp-proxy MUST 按 `items[]` 的顺序逐项执行输入投递，满足：

- 任一输入项执行失败时，acp-proxy MUST 使 run 启动失败
- 失败时 acp-proxy MUST NOT 启动 agent

#### Scenario: One failing item prevents agent start
- **WHEN** 输入清单中某一项执行失败（例如下载失败或 mount 失败）
- **THEN** agent 不被启动且失败原因可追踪到该输入项 `id`

### Requirement: Target paths are validated and constrained to logical roots
acp-proxy MUST 对每个输入项的 `target` 执行路径校验与约束，满足：

- `target` MUST 使用允许的逻辑根目录（至少包含 `WORKSPACE` 与 `USER_HOME`）
- `target.path` MUST 为相对路径且不得包含路径逃逸（例如 `..`）或绝对路径
- 当 `target` 不合法时，acp-proxy MUST 使 run 启动失败并给出明确错误

#### Scenario: Reject path traversal
- **WHEN** 某输入项的 `target.path` 包含 `..` 或以 `/` 开头
- **THEN** acp-proxy 拒绝该输入项并阻止 agent 启动

### Requirement: USER_HOME represents the sandbox home directory (~) for the agent process
系统 SHALL 定义 `USER_HOME` 为沙盒环境内 agent 进程对应 `~` 的 home 目录语义，并在 run 初始化/运行时提供稳定可用的解析结果。

#### Scenario: USER_HOME can be resolved inside the sandbox
- **WHEN** agent 在沙盒内运行且需要访问其 `~` 对应目录
- **THEN** 系统提供的 `USER_HOME` 解析结果指向该进程的 home 目录

### Requirement: bwrap provider can present a complete user view (uid/gid + name + home)
当 sandbox provider 为 `bwrap` 时，系统 SHALL 能组合控制 agent 进程的 UID/GID、用户名解析与 `~`，以满足常见运行时对用户信息的依赖（例如 Node `os.userInfo()`、Python `pwd.getpwuid()`）。

#### Scenario: Username resolves via getpwuid in bwrap
- **WHEN** provider 为 `bwrap` 且 run 配置了 username 与 uid/gid
- **THEN** agent 进程内对当前 uid 的用户名解析返回该 username（而不是空/unknown）

### Requirement: bwrap provider binds workspace and sets working directory to /workspace
当 provider 为 `bwrap` 时，系统 MUST 将 run 的 workspace 绑定到 `/workspace`，并将 agent 进程工作目录设置为 `/workspace`。

#### Scenario: Agent starts in /workspace under bwrap
- **WHEN** provider 为 `bwrap` 且 run 启动 agent
- **THEN** agent 进程启动后的当前工作目录为 `/workspace`

### Requirement: USER_HOME provides a writable state area for agent runtime data
系统 SHALL 允许 agent 在 `USER_HOME` 下写入运行时数据（日志/状态/缓存），不要求固定分层或固定子目录。

#### Scenario: Agent can write logs to state directory
- **WHEN** agent 运行时写入日志到 `USER_HOME` 下任意路径
- **THEN** 写入成功

### Requirement: Zip package inputs are extracted safely into the target directory
当某输入项的 `apply=downloadExtract` 且来源为 zip 包时，acp-proxy MUST 以安全方式下载并解压，满足：

- MUST 防止 ZipSlip（不得写出 target 目录）
- MUST 拒绝 symlink（或等价危险文件类型）
- MUST 施加解压防 DoS 限制（例如文件数/总大小/单文件大小的上限，具体阈值可配置）

#### Scenario: Malicious zip cannot escape target directory
- **WHEN** 输入 zip 包包含指向 target 目录外的文件路径
- **THEN** acp-proxy 解压失败并阻止 agent 启动

## Appendix (Non-normative): Minimal JSON shape (v1)

```json
{
  "agentInputs": {
    "version": 1,
    "envPatch": {
      "HOME": "/home/agent",
      "USER": "agent",
      "LOGNAME": "agent"
    },
    "items": [
      {
        "id": "workspace",
        "apply": "bindMount",
        "access": "rw",
        "source": { "type": "hostPath", "path": "C:/host/workspaces/run-1" },
        "target": { "root": "WORKSPACE", "path": "." }
      },
      {
        "id": "skills",
        "apply": "downloadExtract",
        "access": "rw",
        "source": { "type": "httpZip", "uri": "/api/acp-proxy/skills/packages/<hash>.zip" },
        "target": { "root": "USER_HOME", "path": ".codex/skills" }
      }
    ]
  }
}
```
