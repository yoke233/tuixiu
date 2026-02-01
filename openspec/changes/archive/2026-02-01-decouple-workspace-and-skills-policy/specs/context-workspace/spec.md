## ADDED Requirements

### Requirement: Workspace is a context container
系统 SHALL 将 workspace 视为可组合的上下文容器，能够挂载来自不同来源的资源（如 repo、skills、bundle、artifact）。

#### Scenario: Multiple sources in one workspace
- **WHEN** 一个任务同时需要 repo 与 skills
- **THEN** workspace 同时包含 repo 与 skills 的可访问内容

### Requirement: Workspace mounts define access mode
系统 SHALL 支持对每个挂载源声明访问模式（只读 `ro` 或可写 `rw`）。

#### Scenario: Read-only mounts enforced
- **WHEN** 某挂载源被标记为 `ro`
- **THEN** 运行时禁止对该源进行写入

### Requirement: Workspace lifecycle is declared
系统 SHALL 支持声明 workspace 生命周期（如 `ephemeral` 或 `persisted`），用于决定是否在任务结束后清理。

#### Scenario: Ephemeral workspace cleaned up
- **WHEN** workspace 生命周期为 `ephemeral` 且任务结束
- **THEN** 系统清理该 workspace 的内容

### Requirement: Workspace exposes context inventory
系统 SHALL 在 workspace 内提供可列举的上下文清单（例如清单文件或目录索引），以支持审查与溯源。

#### Scenario: Reviewer reads context inventory
- **WHEN** 角色需要审查已加载资源
- **THEN** workspace 内存在可读取的上下文清单

### Requirement: Context inventory includes sources and versions
系统 SHALL 在上下文清单中记录每个挂载源的类型、来源标识与版本/哈希信息（如技能包版本或 bundle 校验信息）。

#### Scenario: Inventory lists skill versions
- **WHEN** workspace 挂载了 skills 包
- **THEN** 清单中包含每个技能包的版本或内容哈希
