## MODIFIED Requirements

### Requirement: Skills manifest can be applied without repo initialization
系统 SHALL 允许在无仓库初始化模式下仍下发并挂载技能包（skillsManifest），技能挂载与 workspace 初始化逻辑相互独立。

#### Scenario: Skills available in empty workspace policy
- **WHEN** workspacePolicy 为 `empty` 且角色绑定技能
- **THEN** skillsManifest 仍被下发并在运行时可用

### Requirement: Skills are visible within workspace
系统 SHALL 确保已挂载的技能包在 workspace 内可见，以便审查类角色进行列举与检查。

#### Scenario: Reviewer can list skills inside workspace
- **WHEN** workspacePolicy 为 `empty` 且技能挂载完成
- **THEN** workspace 内存在可列举的技能目录或索引文件
