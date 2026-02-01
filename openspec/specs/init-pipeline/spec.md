# init-pipeline

## Purpose

定义 workspace 初始化 pipeline 的动作序列与生成逻辑（TBD）。

## Requirements

### Requirement: Init pipeline is an ordered action list
系统 SHALL 生成有序的初始化动作序列（init pipeline），并按顺序执行。

#### Scenario: Actions executed in order
- **WHEN** pipeline 包含 ensure_workspace 与 init_repo
- **THEN** 系统先确保 workspace 再进行 repo 初始化

### Requirement: Pipeline derived from policies and capabilities
系统 SHALL 基于 workspacePolicy、skillsPolicy 与 agent capabilities 生成 pipeline。

#### Scenario: Pipeline skips repo init for empty policy
- **WHEN** workspacePolicy 为 `empty`
- **THEN** pipeline 不包含 init_repo 动作

### Requirement: Pipeline emits context inventory
系统 SHALL 在初始化完成后生成或更新 workspace 的上下文清单。

#### Scenario: Inventory after init
- **WHEN** pipeline 执行完成
- **THEN** workspace 内存在最新的上下文清单

### Requirement: Pipeline supports bundle initialization
当 workspacePolicy 为 `bundle` 时，系统 SHALL 包含 bundle 初始化动作并将内容展开到 workspace。

#### Scenario: Bundle action populates workspace
- **WHEN** pipeline 包含 init_bundle
- **THEN** workspace 内出现 bundle 展开的内容

### Requirement: Pipeline execution is idempotent
系统 SHALL 确保 pipeline 重试时具备幂等性，避免重复破坏 workspace 状态。

#### Scenario: Retry does not corrupt workspace
- **WHEN** 初始化发生重试
- **THEN** workspace 仍保持可用且内容一致
