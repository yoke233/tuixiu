# role-agent-inputs

## ADDED Requirements

### Requirement: RoleTemplate can store an agentInputs manifest (v1)
系统 SHALL 允许在 RoleTemplate 中持久化存储 `agentInputs`（manifest v1），用于描述该 RoleTemplate 启动 run 时需要投递的输入项。

#### Scenario: Admin saves agentInputs for a RoleTemplate
- **WHEN** 管理员在 RoleTemplate 页面保存一份 `agentInputs`（包含 `version` 与 `items[]`）
- **THEN** 系统持久化保存该 manifest，并在后续读取 RoleTemplate 时可完整回显（round-trip）

### Requirement: Backend validates RoleTemplate agentInputs before saving
系统 MUST 在保存 RoleTemplate 时对 `agentInputs` 执行校验，至少包含：

- `version` 必须为受支持的版本（v1）
- `items[]` 必须为数组
- 每个 item 必须包含 `id/apply/source/target`
- `target.root` 仅允许 `WORKSPACE` 与 `USER_HOME`
- `target.path` 必须为相对路径且不得包含路径逃逸（例如 `..` 或绝对路径）
- `apply` 与 `source.type` 的组合必须合法（例如 `writeFile` 需要 `inlineText`）

#### Scenario: Invalid agentInputs is rejected on save
- **WHEN** 管理员提交不合法的 `agentInputs`（例如 `target.path` 包含 `..`）
- **THEN** 系统拒绝保存并返回可定位的错误信息

### Requirement: RoleTemplate agentInputs are applied per-run to the run USER_HOME/WORKSPACE
系统 MUST 将 RoleTemplate 的 `agentInputs` 作为 run 级别输入，在 run 启动时下发给 acp-proxy，并落地到该 run 对应的 `USER_HOME` 与 `WORKSPACE`。

#### Scenario: Same RoleTemplate does not leak files across runs
- **WHEN** 两个不同的 run 使用同一个 RoleTemplate，并均包含 `target.root=USER_HOME` 的输入项
- **THEN** 两个 run 的 `USER_HOME` 内容相互隔离，任一 run 的写入不影响另一个 run

### Requirement: Frontend provides a structured editor for RoleTemplate agentInputs
前端 MUST 提供结构化编辑器来维护 RoleTemplate 的 `agentInputs.items[]`，至少支持：

- 列表/表格展示 items（id、apply、root、target.path、source.type）
- 新增/编辑/删除/复制 item
- 编辑 `writeFile + inlineText` 的文本内容
- 保存时提交到后端并展示校验错误

#### Scenario: Admin edits writeFile inlineText content via UI
- **WHEN** 管理员在 UI 中选择 `apply=writeFile` 且 `source.type=inlineText` 的 item 并修改其文本内容
- **THEN** 保存后该文本内容被持久化并在再次打开时正确回显

