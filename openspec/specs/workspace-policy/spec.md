# workspace-policy

## Purpose

定义 workspacePolicy 的类型、优先级解析、能力约束与初始化计划（TBD）。

## Requirements

### Requirement: Workspace policy supports git/mount/empty/bundle
系统 SHALL 支持四种 workspacePolicy：`git`、`mount`、`empty`、`bundle`，并允许平台默认 → 项目默认 → 角色覆盖 → 任务显式覆盖的优先级解析。

#### Scenario: Resolve policy with defaults and overrides
- **WHEN** 平台、项目、角色与任务均提供 policy
- **THEN** 系统按照 任务 > 角色 > 项目 > 平台 的顺序解析最终 policy

### Requirement: Policy must be constrained by agent capabilities
系统 SHALL 在启动前校验 agent capabilities 与 workspacePolicy 的兼容性（例如 `mount` 需要 sandbox workspaceProvider=host，`git` 需要 workspaceProvider=guest）。

#### Scenario: Policy incompatible with agent capabilities
- **WHEN** 解析出的 policy 与 agent capabilities 不兼容
- **THEN** 系统拒绝启动并返回明确错误信息

### Requirement: Resolved policy is recorded
系统 SHALL 记录本次运行解析后的 workspacePolicy 及其来源（平台/项目/角色/任务），用于审计与溯源。

#### Scenario: Audit resolved policy
- **WHEN** 运行启动并解析出最终 policy
- **THEN** 系统保存 policy 值与来源优先级信息

### Requirement: Workspace always exists
系统 SHALL 在启动时确保 workspace 目录存在，即便策略为 `empty` 或 `mount`。

#### Scenario: Ensure workspace for empty policy
- **WHEN** workspacePolicy 为 `empty`
- **THEN** 系统创建或复用一个可写 workspace 目录供任务执行

### Requirement: Policy drives init plan generation
系统 SHALL 基于 workspacePolicy 生成启动计划（init env/动作），并将执行逻辑下发给运行时组件。

#### Scenario: Init plan generation for empty policy
- **WHEN** workspacePolicy 为 `empty`
- **THEN** 启动计划不包含 workspace 创建与 repo clone 动作

### Requirement: Empty policy forbids repo credentials injection
当 workspacePolicy 为 `empty` 时，系统 MUST 不注入任何 git 凭据或 repo 相关环境变量（如 TUIXIU_REPO_URL）。

#### Scenario: No git env injected in empty mode
- **WHEN** workspacePolicy 为 `empty`
- **THEN** init env 不包含 TUIXIU_REPO_URL/TUIXIU_GIT_* 等变量

### Requirement: Bundle policy initializes workspace from bundle
当 workspacePolicy 为 `bundle` 时，系统 SHALL 使用指定的 bundle 源初始化 workspace 内容。

#### Scenario: Bundle policy populates workspace
- **WHEN** workspacePolicy 为 `bundle` 且提供 bundle 来源信息
- **THEN** workspace 目录包含 bundle 展开的内容
