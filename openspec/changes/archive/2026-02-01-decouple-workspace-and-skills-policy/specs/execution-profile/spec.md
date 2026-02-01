## ADDED Requirements

### Requirement: Execution profile defines runtime defaults
系统 SHALL 支持定义 execution profile，用于聚合 workspacePolicy、skillsPolicy、toolPolicy 与 dataPolicy 的默认值。

#### Scenario: Role uses profile defaults
- **WHEN** 角色绑定 execution profile 且未显式配置 policy
- **THEN** 系统使用该 profile 的默认策略

### Requirement: Profile can be overridden by role or task
系统 SHALL 允许角色或任务对 profile 中的策略进行覆盖，并遵循优先级解析。

#### Scenario: Task overrides profile
- **WHEN** 任务显式指定 workspacePolicy
- **THEN** 该 policy 覆盖 profile 默认值

### Requirement: Profile changes are auditable
系统 SHALL 记录 profile 的变更与引用关系，以支持审计与回溯。

#### Scenario: Audit profile change
- **WHEN** profile 被更新
- **THEN** 系统可追溯到更新者与生效范围

### Requirement: Run records effective execution profile
系统 SHALL 在运行记录中保存本次执行所使用的 execution profile 及其解析后的策略集合。

#### Scenario: Audit run profile
- **WHEN** 运行启动并绑定 profile
- **THEN** 运行记录包含 profile 标识与生效的策略值
