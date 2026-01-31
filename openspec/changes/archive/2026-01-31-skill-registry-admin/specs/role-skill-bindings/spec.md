## ADDED Requirements

### Requirement: 角色维度的技能启用配置
系统 SHALL 支持在 Project 的 RoleTemplate 维度配置“启用的 skills”，满足：

- 绑定关系 MUST 隶属于某个 `projectId` 且指向该项目下的 `roleTemplateId`
- 每条绑定 MUST 指向一个平台 Skill（通过 `skillId`）
- 绑定 SHOULD 支持 `versionPolicy`（至少 `latest` 与 `pinned`），为后续运行时挂载与回滚预留
- 删除 RoleTemplate 时，其绑定关系 SHOULD 被级联删除

#### Scenario: 为某个角色启用多个技能
- **WHEN** 管理员为某 Project 的某个 RoleTemplate 保存启用的 skill 列表
- **THEN** 系统记录这些启用关系，并在后续读取时返回相同集合

### Requirement: 读取角色启用技能列表接口
系统 SHALL 提供管理员接口读取某个 RoleTemplate 的技能启用配置，满足：

- 接口路径 MUST 为 `GET /api/admin/projects/:projectId/roles/:roleId/skills`
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 当 `projectId` 或 `roleId` 不存在时 MUST 返回业务错误（错误码 `NOT_FOUND`，HTTP status=200；鉴权失败除外）
- 返回体 MUST 至少包含 `roleId/projectId/items[]`
- 每个 item MUST 至少包含 `skillId/name/versionPolicy`

#### Scenario: 读取空配置
- **WHEN** 管理员读取一个尚未配置任何技能的 RoleTemplate
- **THEN** 系统返回 `items=[]`

### Requirement: 写入角色启用技能列表接口（原子替换）
系统 SHALL 提供管理员接口写入某个 RoleTemplate 的技能启用配置，满足：

- 接口路径 MUST 为 `PUT /api/admin/projects/:projectId/roles/:roleId/skills`
- 写入语义 MUST 为“原子替换”（以请求体为准覆盖既有配置）
- 仅 `admin` 角色可访问；未登录 MUST 返回 401，非管理员 MUST 返回 403
- 若请求体引用了不存在的 `skillId` MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）

#### Scenario: 原子替换生效
- **WHEN** 管理员先保存技能集合 A，再保存技能集合 B
- **THEN** 再次读取时系统返回的集合 MUST 等于 B（不包含 A 中被移除的技能）

### Requirement: versionPolicy 基本校验
当绑定条目指定 `versionPolicy=pinned` 时，系统 MUST 验证其引用的版本信息一致性（至少保证“存在且属于该 skill”），否则 MUST 返回业务错误（错误码 `BAD_INPUT`，HTTP status=200；鉴权失败除外）。

#### Scenario: pinned 版本不属于该 skill
- **WHEN** 管理员提交 `versionPolicy=pinned` 且 `pinnedVersionId` 指向另一个 skill 的版本
- **THEN** 系统返回业务错误且错误码为 `BAD_INPUT`

### Requirement: API 响应封装一致性
Role-Skill-Bindings 相关接口 SHALL 统一使用 API Envelope：

- 成功：`{ success: true, data: <payload> }`
- 失败：`{ success: false, error: { code: string, message: string, details?: unknown } }`

#### Scenario: 成功响应结构
- **WHEN** 任一 Role-Skill-Bindings 接口成功返回
- **THEN** 响应 MUST 为 JSON 且包含 `success: true` 与 `data`
